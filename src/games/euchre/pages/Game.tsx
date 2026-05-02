import { useEffect, useMemo, useState } from 'react';
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
import { effectiveSuit, legalPlays } from '../cards';
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

  // Load current trick + plays whenever current_trick_id changes.
  useEffect(() => {
    if (!eu?.current_trick_id) {
      setPlays([]);
      return;
    }
    const trickId = eu.current_trick_id;
    let cancelled = false;
    (async () => {
      const p = await supabase
        .from('trick_plays')
        .select('*')
        .eq('trick_id', trickId)
        .order('played_at');
      if (cancelled) return;
      setPlays((p.data ?? []) as TrickPlayRow[]);
    })();
    const unsub = subscribeWithReconnect({
      channel: `plays-${trickId}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'trick_plays', filter: `trick_id=eq.${trickId}` },
          () => {
            supabase
              .from('trick_plays')
              .select('*')
              .eq('trick_id', trickId)
              .order('played_at')
              .then(({ data }) => setPlays((data ?? []) as TrickPlayRow[]));
          },
        ),
    });
    return () => { cancelled = true; unsub(); };
  }, [eu?.current_trick_id]);

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
  const ledCard = plays[0]?.card ?? null;
  const trump = eu.trump_suit;
  const legalForMe: Card[] =
    phase === 'play' && trump !== null ? legalPlays(myCards, ledCard, trump) : [];

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
            <TurnTimer deadline={game.turn_deadline} serverOffsetMs={serverOffsetMs} />
          )}
          <Link to="/" className="text-sm hover:underline">← Lobby</Link>
        </div>
      </header>

      {error && (
        <div className="mb-3 rounded bg-red-900/50 border border-red-700 p-2 text-sm text-red-200">
          {error}
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
          const cardCount = isMe ? myCards.length : null;
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
                <span className="text-slate-500">team {teamOf(seat)}</span>
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
                  {Array.from({ length: 5 }).map((_, i) => (
                    <CardBack key={i} dim={cardCount !== null && i >= cardCount} />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="col-start-2 row-start-2 flex flex-col items-center justify-center gap-2">
          <TrickArea plays={plays} mySeat={mySeat} usernames={usernames} players={players} />
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
}: {
  plays: TrickPlayRow[];
  mySeat: Seat | null;
  usernames: Map<string, string>;
  players: GamePlayerRow[];
}) {
  if (plays.length === 0) return <div className="text-xs text-slate-500 italic">— trick —</div>;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {plays.map((p) => {
        const player = players.find((pp) => pp.seat === p.seat);
        const name = player?.user_id ? usernames.get(player.user_id) ?? '…' : `seat ${p.seat}`;
        return (
          <div key={p.seat} className="flex flex-col items-center">
            <span className="text-[10px] text-slate-300">{p.seat === mySeat ? 'you' : name}</span>
            <CardButton card={p.card} legal />
          </div>
        );
      })}
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

// Force usage so `effectiveSuit` is type-checked as imported.
void effectiveSuit;
