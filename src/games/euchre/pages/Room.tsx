import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { subscribeWithReconnect } from '../../../lib/realtime';
import { useAuth } from '../../../lib/auth';
import type { GamePlayerRow, GameRow, ProfileRow } from '../../../lib/database.types';
import { euchreApi } from '../api';

interface SeatView {
  seat: number;
  user_id: string | null;
  username: string | null;
  is_bot: boolean;
  isMe: boolean;
}

// Viewer-relative offset → CSS placement in the 3x3 table grid.
// 0 = south (me), 1 = west, 2 = north (partner), 3 = east.
const SEAT_POSITION_FROM_VIEWPOINT: Record<number, string> = {
  0: 'col-start-2 row-start-3',
  1: 'col-start-1 row-start-2',
  2: 'col-start-2 row-start-1',
  3: 'col-start-3 row-start-2',
};

const TURN_TIME_OPTIONS: Array<{ value: number | null; label: string }> = [
  { value: 15,   label: '15 seconds' },
  { value: 30,   label: '30 seconds' },
  { value: 45,   label: '45 seconds (default)' },
  { value: 60,   label: '60 seconds' },
  { value: 120,  label: '2 minutes' },
  { value: null, label: 'No time limit' },
];

export function EuchreRoomPage() {
  const { code } = useParams();
  const { session } = useAuth();
  const navigate = useNavigate();
  const [game, setGame] = useState<GameRow | null>(null);
  const [players, setPlayers] = useState<GamePlayerRow[]>([]);
  const [usernames, setUsernames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [randomize, setRandomize] = useState(false);
  const [swapPick, setSwapPick] = useState<number | null>(null);
  // Encode "no limit" as the string "null" so the <select> can carry it.
  const [turnSecondsChoice, setTurnSecondsChoice] = useState<string>('45');

  useEffect(() => {
    if (!code || !session) return;
    let cancelled = false;

    (async () => {
      const gameResp = await supabase
        .from('games')
        .select('*')
        .eq('invite_code', code.toUpperCase())
        .eq('game', 'euchre')
        .maybeSingle();
      const g = gameResp.data as GameRow | null;
      if (cancelled) return;
      if (gameResp.error) { setError(gameResp.error.message); return; }
      if (!g) { setError('Room not found.'); return; }
      setGame(g);

      const playersResp = await supabase
        .from('game_players')
        .select('*')
        .eq('game_id', g.id)
        .order('seat');
      const ps = (playersResp.data ?? []) as GamePlayerRow[];
      if (cancelled) return;
      if (playersResp.error) { setError(playersResp.error.message); return; }
      setPlayers(ps);

      const meSeated = ps.some((p) => p.user_id === session.user.id);
      if (!meSeated && g.status === 'lobby' && ps.filter((p) => p.user_id || p.is_bot).length < 4) {
        setBusy(true);
        try {
          await euchreApi.joinRoom(code.toUpperCase());
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (!cancelled) setBusy(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [code, session]);

  useEffect(() => {
    if (!game) return;
    const unsubPlayers = subscribeWithReconnect({
      channel: `room-players-${game.id}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'game_players', filter: `game_id=eq.${game.id}` },
          () => refreshPlayers(game.id),
        ),
    });
    const unsubGame = subscribeWithReconnect({
      channel: `room-game-${game.id}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${game.id}` },
          (payload) => setGame(payload.new as GameRow),
        ),
    });
    return () => {
      unsubPlayers();
      unsubGame();
    };
  }, [game?.id]);

  const refreshPlayers = async (gameId: string) => {
    const { data } = await supabase
      .from('game_players')
      .select('*')
      .eq('game_id', gameId)
      .order('seat');
    setPlayers(data ?? []);
  };

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
          for (const row of data as Pick<ProfileRow, 'user_id' | 'username'>[]) {
            next.set(row.user_id, row.username);
          }
          return next;
        });
      });
  }, [players]);

  useEffect(() => {
    if (game?.status === 'playing') {
      navigate(`/games/euchre/g/${game.id}`, { replace: true });
    }
  }, [game?.status, game?.id, navigate]);

  if (!session) return <Navigate to="/login" replace />;

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const seatViews: SeatView[] = useMemo(() =>
    [0, 1, 2, 3].map((seat) => {
      const p = players.find((p) => p.seat === seat);
      return {
        seat,
        user_id: p?.user_id ?? null,
        username: p?.user_id ? usernames.get(p.user_id) ?? '…' : null,
        is_bot: p?.is_bot ?? false,
        isMe: p?.user_id === session.user.id,
      };
    }), [players, usernames, session.user.id]);

  const filledCount = seatViews.filter((s) => s.user_id || s.is_bot).length;
  const leaderId = game?.leader_id
    ?? players.find((p) => p.seat === 0)?.user_id
    ?? null;
  const isLeader = leaderId === session.user.id;
  const canStart = isLeader && filledCount === 4 && game?.status === 'lobby';

  // Viewer's own seat (or 0 by default), so we rotate the table layout
  // to put the viewer at the south position.
  const mySeat = seatViews.find((s) => s.isMe)?.seat ?? 0;
  const positionFor = (seat: number) =>
    SEAT_POSITION_FROM_VIEWPOINT[((seat - mySeat + 4) % 4)];

  const onAddBot = (seat: number) =>
    wrap(async () => { if (game) await euchreApi.roomAddBot(game.id, seat); });
  const onRemoveSeat = (seat: number) =>
    wrap(async () => { if (game) await euchreApi.roomRemoveSeat(game.id, seat); });
  const onSwapClick = (seat: number) => {
    if (!isLeader) return;
    if (swapPick === null) {
      setSwapPick(seat);
    } else if (swapPick === seat) {
      setSwapPick(null);
    } else {
      const a = swapPick, b = seat;
      setSwapPick(null);
      wrap(async () => { if (game) await euchreApi.roomSwapSeats(game.id, a, b); });
    }
  };
  const onFillBots = () =>
    wrap(async () => {
      if (!game) return;
      for (const s of seatViews) {
        if (!s.user_id && !s.is_bot) {
          await euchreApi.roomAddBot(game.id, s.seat);
        }
      }
    });
  const onStart = () =>
    wrap(async () => {
      if (!game) return;
      const turn_seconds = turnSecondsChoice === 'null' ? null : Number(turnSecondsChoice);
      await euchreApi.roomStart(game.id, { randomize, turn_seconds });
    });

  return (
    <div className="min-h-full p-4 sm:p-6 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Euchre — Private Room</h1>
        <Link to="/" className="text-sm hover:underline">← Lobby</Link>
      </header>

      {error && (
        <div className="mb-3 rounded bg-red-900/50 border border-red-700 p-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="mb-6 rounded-lg bg-slate-800 p-4">
        <p className="text-xs text-slate-400 mb-1">Invite code</p>
        <div className="flex items-center gap-3 flex-wrap">
          <code className="text-3xl font-mono tracking-widest text-emerald-300">{code}</code>
          <button
            onClick={() => navigator.clipboard.writeText(code ?? '')}
            className="rounded border border-slate-600 px-3 py-1 text-sm hover:bg-slate-700"
          >
            Copy
          </button>
          <button
            onClick={() => navigator.clipboard.writeText(`${window.location.origin}/games/euchre/room/${code}`)}
            className="rounded border border-slate-600 px-3 py-1 text-sm hover:bg-slate-700"
          >
            Copy link
          </button>
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <p className="text-sm text-slate-400">
            {filledCount}/4 seats filled
            {busy && ' · working…'}
            {isLeader && <span className="ml-2 text-amber-300 text-xs">you're the leader</span>}
          </p>
          {isLeader && swapPick !== null && (
            <p className="text-xs text-violet-300">
              Pick another seat to swap with seat {swapPick}
            </p>
          )}
        </div>

        {/* Table-shape layout: viewer at south (bottom), partner at north
            (top), opponents east/west. Same arrangement as the in-game
            table so partnerships match. */}
        <div className="grid grid-cols-3 grid-rows-3 gap-3 aspect-[5/3] sm:aspect-[7/4] rounded-2xl bg-emerald-950/40 border border-emerald-900 p-3 sm:p-5">
          {seatViews.map((s) => (
            <div key={s.seat} className={`${positionFor(s.seat)} flex`}>
              <SeatCard
                seat={s}
                isLeader={isLeader}
                isSwapPicked={swapPick === s.seat}
                hasSwapPickPending={swapPick !== null}
                busy={busy}
                isLeaderSeat={s.user_id === leaderId}
              isPartner={s.seat !== mySeat && (s.seat % 2) === (mySeat % 2)}
                onAddBot={() => onAddBot(s.seat)}
                onRemove={() => onRemoveSeat(s.seat)}
                onSwapClick={() => onSwapClick(s.seat)}
              />
            </div>
          ))}
          <div className="col-start-2 row-start-2 flex items-center justify-center">
            <span className="text-xs text-emerald-700 uppercase tracking-widest">Lobby</span>
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-slate-700 bg-slate-800/60 p-4 space-y-3">
        {isLeader ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-slate-400">Turn time</span>
                <select
                  value={turnSecondsChoice}
                  onChange={(e) => setTurnSecondsChoice(e.target.value)}
                  className="rounded border border-slate-600 bg-slate-900 px-3 py-2"
                >
                  {TURN_TIME_OPTIONS.map((o) => (
                    <option key={String(o.value)} value={o.value === null ? 'null' : String(o.value)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer self-end pb-1">
                <input
                  type="checkbox"
                  checked={randomize}
                  onChange={(e) => setRandomize(e.target.checked)}
                  className="h-4 w-4 accent-emerald-500"
                />
                Randomize seats when starting
              </label>
            </div>
            {filledCount < 4 && (
              <button
                onClick={onFillBots}
                disabled={busy}
                className="w-full rounded border border-slate-600 hover:bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Fill empty seats with bots
              </button>
            )}
            <button
              onClick={onStart}
              disabled={!canStart || busy}
              className="w-full rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-3 font-semibold text-lg disabled:opacity-50"
            >
              {filledCount < 4 ? `Start game (need ${4 - filledCount} more)` : 'Start game'}
            </button>
          </>
        ) : (
          <p className="text-sm text-slate-400 text-center">
            Waiting for the room leader to start the game…
          </p>
        )}
      </section>
    </div>
  );
}

function SeatCard({
  seat,
  isLeader,
  isSwapPicked,
  hasSwapPickPending,
  busy,
  isLeaderSeat,
  isPartner,
  onAddBot,
  onRemove,
  onSwapClick,
}: {
  seat: SeatView;
  isLeader: boolean;
  isSwapPicked: boolean;
  hasSwapPickPending: boolean;
  busy: boolean;
  isLeaderSeat: boolean;
  isPartner: boolean;
  onAddBot: () => void;
  onRemove: () => void;
  onSwapClick: () => void;
}) {
  const empty = !seat.user_id && !seat.is_bot;
  const ringClass = isSwapPicked
    ? 'ring-2 ring-violet-400'
    : seat.isMe
      ? 'ring-2 ring-emerald-400'
      : isPartner
        ? 'ring-1 ring-emerald-700'
        : '';

  return (
    <div
      className={`flex-1 min-w-0 rounded-lg border border-slate-700 bg-slate-800 p-3 ${ringClass} flex flex-col`}
    >
      <div className="flex items-center justify-between mb-1 text-[10px] uppercase tracking-wider text-slate-400">
        <span>
          {seat.isMe ? 'You' : isPartner ? 'Partner' : 'Opponent'}
        </span>
        {isLeaderSeat && <span className="text-amber-300">leader</span>}
      </div>
      <div className="font-medium text-base flex-1">
        {empty ? (
          <span className="text-slate-500 italic">empty</span>
        ) : seat.is_bot ? (
          <span className="text-slate-300">Bot</span>
        ) : (
          <span className="break-words">{seat.username}</span>
        )}
      </div>
      {isLeader && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {empty && (
            <button
              onClick={onAddBot}
              disabled={busy}
              className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs disabled:opacity-50"
            >
              Add bot
            </button>
          )}
          {!empty && !seat.isMe && (
            <button
              onClick={onRemove}
              disabled={busy}
              className="rounded border border-slate-600 hover:bg-slate-700 px-2 py-1 text-xs disabled:opacity-50"
            >
              {seat.is_bot ? 'Remove' : 'Kick'}
            </button>
          )}
          <button
            onClick={onSwapClick}
            disabled={busy}
            className={`rounded px-2 py-1 text-xs disabled:opacity-50 ${
              isSwapPicked
                ? 'bg-violet-600 hover:bg-violet-500'
                : 'border border-slate-600 hover:bg-slate-700'
            }`}
          >
            {isSwapPicked ? 'Cancel' : hasSwapPickPending ? 'Swap here' : 'Swap'}
          </button>
        </div>
      )}
    </div>
  );
}
