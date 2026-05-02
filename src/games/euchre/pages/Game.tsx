import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { subscribeWithReconnect } from '../../../lib/realtime';
import { useAuth } from '../../../lib/auth';
import type {
  Card,
  EuchreGameRow,
  GameHandRow,
  GamePlayerRow,
  GameRow,
  ProfileRow,
  Suit,
  TrickPlayRow,
} from '../../../lib/database.types';
import { effectiveSuit, legalPlays, trickWinner } from '../cards';
import { RANK_LABEL, SUIT_LABEL, isRed, rankOf, suitOf } from '../../../lib/cards-base';
import { BidPanel } from '../components/BidPanel';
import { ScorePanel } from '../components/ScorePanel';
import { TurnTimer } from '../../../components/TurnTimer';
import { euchreApi } from '../api';

type Seat = 0 | 1 | 2 | 3;
const teamOf = (seat: number): 0 | 1 => (seat % 2) as 0 | 1;

const SEAT_POSITION_FROM_VIEWPOINT: Record<number, string> = {
  // We rotate so the viewer sits at "south" (bottom).
  0: 'col-start-2 row-start-3', // self / south
  1: 'col-start-1 row-start-2', // left of self
  2: 'col-start-2 row-start-1', // partner / north
  3: 'col-start-3 row-start-2', // right of self
};

export function EuchreGamePage() {
  const { gameId } = useParams();
  const { session } = useAuth();
  const [game, setGame] = useState<GameRow | null>(null);
  const [eu, setEu] = useState<EuchreGameRow | null>(null);
  const [players, setPlayers] = useState<GamePlayerRow[]>([]);
  const [usernames, setUsernames] = useState<Map<string, string>>(new Map());
  const [hand, setHand] = useState<GameHandRow | null>(null);
  const [plays, setPlays] = useState<TrickPlayRow[]>([]);
  // Resolved tricks for the entire game; we filter by current hand_number
  // when rendering trick counts.
  const [resolvedTricks, setResolvedTricks] = useState<Array<{ id: string; hand_number: number; winner_seat: number | null }>>([]);
  // Snapshot of the most-recently-completed trick — kept on screen for ~2.5s
  // after current_trick_id clears so players can see who won. We stamp the
  // hand number onto the snapshot so the renderer can drop it the instant
  // the hand advances, without relying on Realtime event ordering.
  const [recentTrick, setRecentTrick] = useState<{
    plays: TrickPlayRow[];
    winnerSeat: number | null;
    handNumber: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);

  // Initial state load + estimate server clock offset.
  useEffect(() => {
    if (!gameId || !session) return;
    let cancelled = false;
    (async () => {
      const t0 = Date.now();
      const [g, eu, ps, h] = await Promise.all([
        supabase.from('games').select('*').eq('id', gameId).maybeSingle(),
        supabase.from('euchre_games').select('*').eq('game_id', gameId).maybeSingle(),
        supabase.from('game_players').select('*').eq('game_id', gameId).order('seat'),
        supabase
          .from('game_hands')
          .select('*')
          .eq('game_id', gameId)
          .eq('user_id', session.user.id)
          .maybeSingle(),
      ]);
      const t1 = Date.now();
      if (cancelled) return;
      if (g.error) setError(g.error.message);
      setGame(g.data as GameRow | null);
      setEu(eu.data as EuchreGameRow | null);
      setPlayers((ps.data ?? []) as GamePlayerRow[]);
      setHand(h.data as GameHandRow | null);

      // Server-now estimate: round trip + server header.
      const headerDate = (g.data as { updated_at?: string } | null)?.updated_at;
      if (headerDate) {
        const serverNow = new Date(headerDate).getTime();
        const localMid = (t0 + t1) / 2;
        // updated_at lags actual now; only use if positive. Otherwise leave 0.
        const diff = serverNow - localMid;
        if (Math.abs(diff) < 60_000) setServerOffsetMs(diff);
      }
    })();
    return () => { cancelled = true; };
  }, [gameId, session]);

  // Subscriptions.
  useEffect(() => {
    if (!gameId || !session) return;
    const unsubGame = subscribeWithReconnect({
      channel: `game-${gameId}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` },
          (p) => setGame(p.new as GameRow),
        ),
    });
    const unsubEu = subscribeWithReconnect({
      channel: `eu-${gameId}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'euchre_games', filter: `game_id=eq.${gameId}` },
          (p) => setEu(p.new as EuchreGameRow),
        ),
    });
    const unsubPlayers = subscribeWithReconnect({
      channel: `players-${gameId}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'game_players', filter: `game_id=eq.${gameId}` },
          () => {
            supabase
              .from('game_players')
              .select('*')
              .eq('game_id', gameId)
              .order('seat')
              .then(({ data }) => setPlayers((data ?? []) as GamePlayerRow[]));
          },
        ),
    });
    const unsubHand = subscribeWithReconnect({
      channel: `hand-${gameId}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'game_hands',
            filter: `game_id=eq.${gameId}`,
          },
          (p) => {
            const row = p.new as GameHandRow | undefined;
            if (row && row.user_id === session.user.id) setHand(row);
          },
        ),
    });
    return () => {
      unsubGame();
      unsubEu();
      unsubPlayers();
      unsubHand();
    };
  }, [gameId, session]);

  // Holds whichever trick id we last saw an active subscription for. When
  // current_trick_id transitions to null, we use this to deterministically
  // fetch the just-completed trick's full play set from the DB — which
  // sidesteps the Realtime ordering race where the 4th trick_plays INSERT
  // event can arrive after the euchre_games UPDATE that cleared
  // current_trick_id, causing the snapshot to capture only 3 plays.
  const prevTrickIdRef = useRef<string | null>(null);

  // Load current trick + plays whenever current_trick_id changes.
  useEffect(() => {
    if (!eu?.current_trick_id) {
      const completedTrickId = prevTrickIdRef.current;
      prevTrickIdRef.current = null;
      const trump = eu?.trump_suit;
      const handNumber = eu?.hand_number;
      setPlays([]);
      if (completedTrickId && trump && handNumber !== undefined) {
        // Fetch authoritative play set from DB so we capture the 4th
        // (or 3rd, if alone) card even when Realtime hasn't delivered
        // the INSERT event by the time we reach this effect.
        let cancelled = false;
        (async () => {
          const { data } = await supabase
            .from('trick_plays')
            .select('*')
            .eq('trick_id', completedTrickId)
            .order('played_at');
          if (cancelled) return;
          const allPlays = (data ?? []) as TrickPlayRow[];
          if (allPlays.length > 0) {
            const winnerSeat = trickWinner(
              allPlays.map((p) => ({ seat: p.seat, card: p.card })),
              trump,
            );
            setRecentTrick({ plays: allPlays, winnerSeat, handNumber });
          }
        })();
        return () => { cancelled = true; };
      }
      return;
    }
    const trickId = eu.current_trick_id;
    prevTrickIdRef.current = trickId;
    let cancelled = false;
    const fetchPlays = async () => {
      if (cancelled) return;
      const { data } = await supabase
        .from('trick_plays')
        .select('*')
        .eq('trick_id', trickId)
        .order('played_at');
      if (cancelled) return;
      setPlays((data ?? []) as TrickPlayRow[]);
    };
    fetchPlays();
    const unsub = subscribeWithReconnect({
      channel: `plays-${trickId}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'trick_plays', filter: `trick_id=eq.${trickId}` },
          () => fetchPlays(),
        ),
    });
    return () => { cancelled = true; unsub(); };
  }, [eu?.current_trick_id]);

  // Auto-clear the recent-trick snapshot after a beat.
  useEffect(() => {
    if (!recentTrick) return;
    const t = setTimeout(() => setRecentTrick(null), 2500);
    return () => clearTimeout(t);
  }, [recentTrick]);

  // Resolved tricks for the whole game — drives the per-seat / per-team
  // counts. Live-refreshed on any tricks update.
  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    const refresh = async () => {
      const { data } = await supabase
        .from('tricks')
        .select('id, hand_number, winner_seat')
        .eq('game_id', gameId);
      if (cancelled) return;
      setResolvedTricks((data ?? []) as Array<{ id: string; hand_number: number; winner_seat: number | null }>);
    };
    refresh();
    const unsub = subscribeWithReconnect({
      channel: `tricks-${gameId}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'tricks', filter: `game_id=eq.${gameId}` },
          () => refresh(),
        ),
    });
    return () => { cancelled = true; unsub(); };
  }, [gameId]);

  // Resolve usernames once.
  useEffect(() => {
    const ids = players.map((p) => p.user_id).filter((u): u is string => u !== null);
    const missing = ids.filter((id) => !usernames.has(id));
    if (missing.length === 0) return;
    supabase
      .from('profiles')
      .select('user_id, username')
      .in('user_id', missing)
      .then(({ data }) => {
        if (!data) return;
        setUsernames((prev) => {
          const next = new Map(prev);
          for (const r of data as Pick<ProfileRow, 'user_id' | 'username'>[]) next.set(r.user_id, r.username);
          return next;
        });
      });
  }, [players]);

  if (!session) return <Navigate to="/login" replace />;

  const mySeat = useMemo<Seat | null>(() => {
    const me = players.find((p) => p.user_id === session.user.id);
    return me ? (me.seat as Seat) : null;
  }, [players, session]);

  if (!game || !eu) {
    return (
      <div className="p-6 text-slate-400">
        Loading game…
        {error && <div className="text-red-400 text-sm mt-2">{error}</div>}
      </div>
    );
  }

  if (game.status === 'finished') {
    const winner = game.team0_score >= 10 ? 0 : 1;
    return (
      <div className="min-h-full p-6 max-w-2xl mx-auto text-center">
        <h1 className="text-3xl font-bold mb-2">Game over</h1>
        <p className="text-xl text-emerald-300 mb-4">
          Team {winner} wins {game.team0_score}–{game.team1_score}
        </p>
        <Link to="/" className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2">
          Back to lobby
        </Link>
      </div>
    );
  }

  const phase = derivePhase(eu);

  const isMyTurn = mySeat !== null && game.current_seat === mySeat;

  const myCards = hand?.cards ?? [];
  // Belt-and-suspenders: ledCard must come from the *currently active*
  // trick. If the server says no trick is open (current_trick_id null —
  // i.e., we're about to lead), force ledCard=null so legalForMe can't
  // accidentally inherit a stale lead from the previous trick or hand.
  const ledCard = eu.current_trick_id ? plays[0]?.card ?? null : null;
  const trump = eu.trump_suit;
  const legalForMe: Card[] =
    phase === 'play' && trump !== null ? legalPlays(myCards, ledCard, trump) : [];

  // Tricks won this hand — counts per seat plus team rollups.
  // Important: skip a trick whose id still matches eu.current_trick_id.
  // Realtime can deliver the tricks UPDATE (winner_seat set) before the
  // euchre_games UPDATE (current_trick_id cleared), and during that
  // window the trick's plays are still in `plays` state. Counting it
  // here too would double-count and briefly drop opponent backs by one
  // extra card.
  const tricksPerSeat: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let tricksThisHand = 0;
  for (const t of resolvedTricks) {
    if (
      t.hand_number === eu.hand_number &&
      t.winner_seat !== null &&
      t.id !== eu.current_trick_id
    ) {
      tricksPerSeat[t.winner_seat] = (tricksPerSeat[t.winner_seat] ?? 0) + 1;
      tricksThisHand += 1;
    }
  }
  const tricksTeam0 = tricksPerSeat[0] + tricksPerSeat[2];
  const tricksTeam1 = tricksPerSeat[1] + tricksPerSeat[3];

  // Cards remaining for an opponent seat. Each completed trick removes one
  // card from every active player; if a play exists for this seat in the
  // current (uncompleted) trick, that's another card already on the table.
  // The partner of an alone-caller stays at 5 — they don't play this hand.
  const aloneSeat = eu.alone_seat;
  const alonePartnerSeat: number | null =
    aloneSeat === null ? null : ((aloneSeat + 2) % 4);
  const cardsRemainingFor = (seat: Seat): number => {
    if (alonePartnerSeat !== null && seat === alonePartnerSeat) return 5;
    const playedThisTrick = plays.some((p) => p.seat === seat) ? 1 : 0;
    return Math.max(0, 5 - tricksThisHand - playedThisTrick);
  };

  // Render seat positions relative to the viewer's seat.
  const positionFor = (seat: Seat): string => {
    if (mySeat === null) return SEAT_POSITION_FROM_VIEWPOINT[seat];
    const offset = ((seat - mySeat + 4) % 4) as 0 | 1 | 2 | 3;
    return SEAT_POSITION_FROM_VIEWPOINT[offset];
  };

  const onPass = guard(() => euchreApi.pass(game.id));
  const onOrderUp = (alone: boolean) => guard(() => euchreApi.orderUp(game.id, alone));
  const onCallTrump = (suit: Suit, alone: boolean) => guard(() => euchreApi.callTrump(game.id, suit, alone));
  const onDiscard = (card: Card) => guard(() => euchreApi.discard(game.id, card));
  const onPlay = (card: Card) => guard(() => euchreApi.playCard(game.id, card));
  const onResume = guard(() => euchreApi.resumeControl(game.id));

  const myPlayerRow = mySeat !== null ? players.find((p) => p.seat === mySeat) : undefined;
  const meIsBot = myPlayerRow?.is_bot === true;

  function guard<T>(fn: () => Promise<T>): () => Promise<void> {
    return async () => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try { await fn(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    };
  }

  return (
    <div className="min-h-full p-3 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold">Euchre</h1>
          <p className="text-xs text-slate-400">
            Hand {eu.hand_number} · Phase: <span className="text-slate-200">{phase}</span>
            {trump && <> · Trump <span className="text-slate-200">{SUIT_LABEL[trump]}</span></>}
            {eu.alone_seat !== null && (
              <> · Alone: <span className="text-amber-300">seat {eu.alone_seat}</span></>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {game.turn_deadline && phase !== 'finished' && (
            <TurnTimer
              deadline={game.turn_deadline}
              serverOffsetMs={serverOffsetMs}
              onExpire={(deadline) => {
                if (game.current_seat === null) return;
                euchreApi
                  .enforceTimeout(game.id, game.current_seat, deadline)
                  .catch(() => {
                    // Swallow — multiple clients may race; only one wins, the
                    // rest get acted=false. Realtime delivers the new state.
                  });
              }}
            />
          )}
          <Link to="/" className="text-sm hover:underline">← Lobby</Link>
        </div>
      </header>

      {error && (
        <div className="mb-3 rounded bg-red-900/50 border border-red-700 p-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {meIsBot && (
        <div className="mb-3 rounded bg-amber-900/40 border border-amber-700 p-3 text-sm flex items-center justify-between gap-3 flex-wrap">
          <span>A bot is playing your seat after missed turns.</span>
          <button
            onClick={() => onResume()}
            disabled={busy}
            className="rounded bg-amber-500 hover:bg-amber-400 text-slate-900 px-3 py-1 font-medium disabled:opacity-50"
          >
            Resume control
          </button>
        </div>
      )}

      <div className="grid grid-cols-3 grid-rows-3 gap-3 bg-felt-dark p-4 rounded-2xl min-h-[55vh]">
        {([0, 1, 2, 3] as Seat[]).map((seat) => {
          const p = players.find((pp) => pp.seat === seat);
          const username = p?.user_id ? usernames.get(p.user_id) ?? '…' : 'open';
          const isMe = mySeat === seat;
          const isCurrent = game.current_seat === seat;
          const isDealer = eu.dealer_seat === seat;
          const isMaker = eu.maker_seat === seat;
          const cardCount = isMe ? myCards.length : cardsRemainingFor(seat);
          return (
            <div
              key={seat}
              className={`${positionFor(seat)} rounded-xl border-2 p-2 bg-slate-900/60 ${
                isCurrent ? 'border-emerald-400' : 'border-slate-700'
              }`}
            >
              <div className="text-xs flex justify-between mb-1">
                <span className="font-semibold">
                  {username} {isMe && <span className="text-emerald-400">(you)</span>}
                  {isDealer && <span className="text-amber-300 ml-1">D</span>}
                  {isMaker && <span className="text-emerald-300 ml-1">M</span>}
                  {p?.is_bot && <span className="text-slate-500 ml-1">[bot]</span>}
                </span>
                <span className="text-slate-500">
                  team {teamOf(seat)} · {tricksPerSeat[seat]}t
                </span>
              </div>
              {isMe ? (
                <div className="flex flex-wrap gap-1">
                  {myCards.length === 0 ? (
                    <span className="text-xs text-slate-500 italic">empty</span>
                  ) : (
                    myCards.map((c) => (
                      <CardButton
                        key={c}
                        card={c}
                        legal={phase === 'play' ? legalForMe.includes(c) : true}
                        onClick={
                          phase === 'play' && isMyTurn && legalForMe.includes(c)
                            ? () => onPlay(c)()
                            : phase === 'discard' && isMyTurn
                            ? () => onDiscard(c)()
                            : undefined
                        }
                      />
                    ))
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap gap-0.5">
                  {cardCount === 0 ? (
                    <span className="text-xs text-slate-500 italic">empty</span>
                  ) : (
                    Array.from({ length: cardCount ?? 5 }).map((_, i) => (
                      <CardBack key={i} dim={false} />
                    ))
                  )}
                </div>
              )}
              <TrickStack count={tricksPerSeat[seat]} />
            </div>
          );
        })}

        {trump && (
          <div className="col-start-1 row-start-1 flex items-start justify-start">
            <div
              className={`rounded-md border-2 px-2 py-1 ${
                trump === 'D' || trump === 'H'
                  ? 'bg-rose-950/80 border-rose-700 text-rose-300'
                  : 'bg-slate-800 border-slate-600 text-slate-200'
              }`}
            >
              <div className="text-[10px] uppercase tracking-widest opacity-70">Trump</div>
              <div className="text-3xl leading-none">{SUIT_LABEL[trump]}</div>
              {eu.maker_seat !== null && (
                <div className="text-[10px] opacity-70 mt-0.5">
                  by {eu.maker_seat === mySeat
                    ? 'you'
                    : (() => {
                        const p = players.find((pp) => pp.seat === eu.maker_seat);
                        return p?.user_id ? usernames.get(p.user_id) ?? `seat ${eu.maker_seat}` : `seat ${eu.maker_seat}`;
                      })()}
                  {eu.alone_seat !== null && <span className="ml-1 text-amber-300">·alone</span>}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="col-start-2 row-start-2 flex flex-col items-center justify-center gap-2">
          <TrickArea
            // Only show live plays when the server says a trick is active
            // — guards against stale Realtime callbacks repopulating the
            // plays state with cards from the previous trick after we've
            // already advanced to a new hand.
            plays={eu.current_trick_id ? plays : []}
            mySeat={mySeat}
            usernames={usernames}
            players={players}
            // Drop the held snapshot the instant the hand advances —
            // prevents the previous hand's last trick from ghosting in
            // when the new face-up card appears.
            completed={
              recentTrick && recentTrick.handNumber === eu.hand_number ? recentTrick : null
            }
          />
          {eu.upcard && eu.upcard_status !== 'taken' && (
            <UpcardDisplay card={eu.upcard} status={eu.upcard_status ?? 'face_up'} />
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          {phase === 'bid_round_1' && eu.upcard && isMyTurn && mySeat !== null && (
            <BidPanel
              round={1}
              upcardSuit={suitOf(eu.upcard)}
              isDealer={mySeat === eu.dealer_seat}
              onPass={() => onPass()}
              onOrderUp={(alone) => onOrderUp(alone)()}
            />
          )}
          {phase === 'bid_round_2' && eu.upcard && isMyTurn && mySeat !== null && (
            <BidPanel
              round={2}
              excludedSuit={suitOf(eu.upcard)}
              isDealer={mySeat === eu.dealer_seat}
              onPass={() => onPass()}
              onCall={(suit, alone) => onCallTrump(suit, alone)()}
            />
          )}
          {phase === 'discard' && isMyTurn && mySeat !== null && (
            <p className="rounded bg-slate-800/90 p-3 text-sm">Click a card in your hand to discard.</p>
          )}
          {phase === 'play' && isMyTurn && (
            <p className="rounded bg-slate-800/90 p-3 text-sm">Your turn — click a highlighted card.</p>
          )}
          {!isMyTurn && (
            <p className="rounded bg-slate-800/90 p-3 text-sm text-slate-400">
              Waiting on {usernames.get(players.find((p) => p.seat === game.current_seat)?.user_id ?? '') ?? `seat ${game.current_seat}`}…
            </p>
          )}
        </div>
        <ScorePanel
          team0={game.team0_score}
          team1={game.team1_score}
          trumpSuit={trump ? SUIT_LABEL[trump] : undefined}
          makerTeam={eu.maker_seat !== null ? teamOf(eu.maker_seat) : undefined}
          myTeam={mySeat !== null ? teamOf(mySeat) : undefined}
          tricks={trump !== null ? { team0: tricksTeam0, team1: tricksTeam1 } : undefined}
        />
      </div>
    </div>
  );
}

function derivePhase(eu: EuchreGameRow): 'bid_round_1' | 'bid_round_2' | 'discard' | 'play' | 'finished' {
  if (eu.trump_suit === null) {
    return eu.upcard_status === 'face_up' ? 'bid_round_1' : 'bid_round_2';
  }
  if (eu.upcard !== null && eu.upcard_status === 'taken') return 'discard';
  return 'play';
}

function TrickArea({
  plays,
  mySeat,
  usernames,
  players,
  completed,
}: {
  plays: TrickPlayRow[];
  mySeat: Seat | null;
  usernames: Map<string, string>;
  players: GamePlayerRow[];
  completed: { plays: TrickPlayRow[]; winnerSeat: number | null } | null;
}) {
  if (plays.length === 0 && !completed) {
    return <div className="text-xs text-slate-500 italic">— trick —</div>;
  }
  // Active trick takes priority over the completed-snapshot.
  const showing = plays.length > 0 ? plays : completed!.plays;
  const winnerSeat = plays.length > 0 ? null : completed!.winnerSeat;
  const isCompletedView = plays.length === 0 && !!completed;
  const winnerName = (() => {
    if (winnerSeat === null) return null;
    const p = players.find((pp) => pp.seat === winnerSeat);
    if (!p?.user_id) return `seat ${winnerSeat}`;
    if (winnerSeat === mySeat) return 'you';
    return usernames.get(p.user_id) ?? `seat ${winnerSeat}`;
  })();
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {showing.map((p) => {
          const player = players.find((pp) => pp.seat === p.seat);
          const name = player?.user_id ? usernames.get(player.user_id) ?? '…' : `seat ${p.seat}`;
          const isWinner = winnerSeat !== null && p.seat === winnerSeat;
          const dim = isCompletedView && !isWinner;
          return (
            <div key={p.seat} className="flex flex-col items-center">
              <span className="text-[10px] text-slate-300">{p.seat === mySeat ? 'you' : name}</span>
              <div className={dim ? 'opacity-40 grayscale' : isWinner ? 'ring-2 ring-emerald-300 rounded' : ''}>
                <CardButton card={p.card} legal />
              </div>
            </div>
          );
        })}
      </div>
      {winnerName && (
        <div className="text-xs text-emerald-300">won by {winnerName}</div>
      )}
    </div>
  );
}

function UpcardDisplay({ card, status }: { card: Card; status: 'face_up' | 'turned_down' | 'taken' }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[10px] text-slate-300 uppercase">{status.replace('_', ' ')}</span>
      <CardButton card={card} legal={status === 'face_up'} />
    </div>
  );
}

function CardButton({ card, legal, onClick }: { card: Card; legal: boolean; onClick?: () => void }) {
  const suit = suitOf(card);
  const rank = rankOf(card);
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`flex h-16 w-12 flex-col items-center justify-between rounded border-2 bg-white px-1 py-0.5 ${
        isRed(suit) ? 'text-red-600' : 'text-black'
      } ${
        onClick
          ? 'border-emerald-400 hover:-translate-y-1 transition cursor-pointer'
          : legal
          ? 'border-slate-300'
          : 'border-slate-500 opacity-40'
      }`}
    >
      <span className="self-start text-xs font-bold">{RANK_LABEL[rank]}</span>
      <span className="text-lg">{SUIT_LABEL[suit]}</span>
      <span className="self-end text-xs font-bold rotate-180">{RANK_LABEL[rank]}</span>
    </button>
  );
}

function CardBack({ dim }: { dim: boolean }) {
  return (
    <div
      className={`h-12 w-9 rounded border bg-blue-700 border-blue-900 ${
        dim ? 'opacity-20' : ''
      }`}
      style={{
        backgroundImage:
          'repeating-linear-gradient(45deg, transparent 0 4px, rgba(255,255,255,0.1) 4px 8px)',
      }}
    />
  );
}

// Tiny stack of face-down cards next to a seat — one tile per trick won
// in the current hand. Renders nothing when count is 0.
function TrickStack({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className="flex">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="h-3 w-5 rounded-sm border border-blue-950 bg-blue-700 -ml-2 first:ml-0"
            style={{
              backgroundImage:
                'repeating-linear-gradient(45deg, transparent 0 2px, rgba(255,255,255,0.15) 2px 4px)',
            }}
          />
        ))}
      </div>
      <span className="text-[10px] text-slate-400">{count} won</span>
    </div>
  );
}

// Force usage so `effectiveSuit` is type-checked as imported.
void effectiveSuit;
