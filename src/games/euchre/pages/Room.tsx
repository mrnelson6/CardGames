import { useEffect, useState } from 'react';
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

      // Auto-join if I'm not seated.
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

  const seatViews: SeatView[] = [0, 1, 2, 3].map((seat) => {
    const p = players.find((p) => p.seat === seat);
    return {
      seat,
      user_id: p?.user_id ?? null,
      username: p?.user_id ? usernames.get(p.user_id) ?? '…' : null,
      is_bot: p?.is_bot ?? false,
      isMe: p?.user_id === session.user.id,
    };
  });

  const filledCount = seatViews.filter((s) => s.user_id || s.is_bot).length;
  const leaderId = game?.leader_id
    ?? players.find((p) => p.seat === 0)?.user_id
    ?? null;
  const isLeader = leaderId === session.user.id;
  const canStart = isLeader && filledCount === 4 && game?.status === 'lobby';

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
      if (game) await euchreApi.roomStart(game.id, { randomize });
    });

  return (
    <div className="min-h-full p-4 sm:p-6 max-w-3xl mx-auto">
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
        <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
          <p className="text-sm text-slate-400">
            {filledCount}/4 seats filled
            {busy && ' · working…'}
            {isLeader && <span className="ml-2 text-amber-300 text-xs">you're the leader</span>}
          </p>
          {isLeader && swapPick !== null && (
            <p className="text-xs text-violet-300">
              Pick another seat to swap with seat {swapPick} (or click seat {swapPick} to cancel)
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {seatViews.map((s) => (
            <SeatCard
              key={s.seat}
              seat={s}
              isLeader={isLeader}
              isSwapPicked={swapPick === s.seat}
              hasSwapPickPending={swapPick !== null}
              busy={busy}
              isLeaderSeat={s.user_id === leaderId}
              onAddBot={() => onAddBot(s.seat)}
              onRemove={() => onRemoveSeat(s.seat)}
              onSwapClick={() => onSwapClick(s.seat)}
            />
          ))}
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-slate-700 bg-slate-800/60 p-4 space-y-3">
        {isLeader ? (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={randomize}
                  onChange={(e) => setRandomize(e.target.checked)}
                  className="h-4 w-4 accent-emerald-500"
                />
                Randomize seats when starting
              </label>
              {filledCount < 4 && (
                <button
                  onClick={onFillBots}
                  disabled={busy}
                  className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  Fill empty seats with bots
                </button>
              )}
            </div>
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
  onAddBot: () => void;
  onRemove: () => void;
  onSwapClick: () => void;
}) {
  const team = seat.seat % 2;
  const empty = !seat.user_id && !seat.is_bot;
  const teamColor = team === 0 ? 'border-l-emerald-500' : 'border-l-sky-500';
  const ringClass = isSwapPicked ? 'ring-2 ring-violet-400' : seat.isMe ? 'ring-1 ring-emerald-500/70' : '';

  return (
    <div
      className={`rounded-lg border border-slate-700 border-l-4 ${teamColor} bg-slate-800 p-3 ${ringClass}`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-slate-400">
          Seat {seat.seat} · team {team}
        </div>
        {isLeaderSeat && (
          <span className="text-[10px] uppercase tracking-wider text-amber-300">leader</span>
        )}
      </div>
      <div className="font-medium text-base">
        {empty ? (
          <span className="text-slate-500 italic">empty</span>
        ) : seat.is_bot ? (
          <span className="text-slate-300">Bot</span>
        ) : (
          <>
            {seat.username}
            {seat.isMe && <span className="ml-2 text-xs text-emerald-400">(you)</span>}
          </>
        )}
      </div>
      {isLeader && (
        <div className="mt-3 flex flex-wrap gap-2">
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
              {seat.is_bot ? 'Remove bot' : 'Kick'}
            </button>
          )}
          {!empty && (
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
          )}
        </div>
      )}
    </div>
  );
}
