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

  useEffect(() => {
    if (!code || !session) return;
    let cancelled = false;

    (async () => {
      // Look up game by invite_code.
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

      // Auto-join if I'm not seated and the room is still in lobby.
      const meSeated = ps.some((p) => p.user_id === session.user.id);
      if (!meSeated && g.status === 'lobby' && ps.length < 4) {
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

  // Realtime: game_players changes + games status flip.
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
          (payload) => {
            const next = payload.new as GameRow;
            setGame(next);
          },
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

  // Resolve usernames.
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

  // Status flip → navigate to game page.
  useEffect(() => {
    if (game?.status === 'playing') {
      navigate(`/games/euchre/g/${game.id}`, { replace: true });
    }
  }, [game?.status, game?.id, navigate]);

  if (!session) return <Navigate to="/login" replace />;

  const seatViews: SeatView[] = [0, 1, 2, 3].map((seat) => {
    const p = players.find((p) => p.seat === seat);
    return {
      seat,
      user_id: p?.user_id ?? null,
      username: p?.user_id ? usernames.get(p.user_id) ?? '…' : null,
      isMe: p?.user_id === session.user.id,
    };
  });

  const fullness = players.length;

  return (
    <div className="min-h-full p-6 max-w-2xl mx-auto">
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
        <div className="flex items-center gap-3">
          <code className="text-3xl font-mono tracking-widest text-emerald-300">{code}</code>
          <button
            onClick={() => navigator.clipboard.writeText(code ?? '')}
            className="rounded border border-slate-600 px-3 py-1 text-sm hover:bg-slate-700"
          >
            Copy
          </button>
          <button
            onClick={() => navigator.clipboard.writeText(`${window.location.origin}/#/games/euchre/room/${code}`)}
            className="rounded border border-slate-600 px-3 py-1 text-sm hover:bg-slate-700"
          >
            Copy link
          </button>
        </div>
      </section>

      <section>
        <p className="text-sm text-slate-400 mb-2">
          {fullness < 4
            ? `Waiting for ${4 - fullness} more player${fullness === 3 ? '' : 's'}…`
            : 'Starting game…'}
          {busy && ' (joining…)'}
        </p>
        <ul className="space-y-2">
          {seatViews.map((s) => (
            <li
              key={s.seat}
              className={`flex items-center justify-between rounded border px-3 py-2 ${
                s.isMe ? 'border-emerald-500 bg-emerald-950/30' : 'border-slate-700 bg-slate-800'
              }`}
            >
              <span className="text-sm">
                <span className="text-slate-400 mr-2">Seat {s.seat}</span>
                <span className="text-xs text-slate-500">team {s.seat % 2}</span>
              </span>
              <span className="text-sm font-medium">
                {s.username ?? <span className="text-slate-500">empty</span>}
                {s.isMe && <span className="ml-2 text-xs text-emerald-400">(you)</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
