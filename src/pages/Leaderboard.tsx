import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { ProfileRow, RatingRow } from '../lib/database.types';

type Mode = 'solo' | 'duo';
type Row = Pick<RatingRow, 'user_id' | 'elo' | 'games_played'> & { username: string };

const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'solo', label: 'Solo' },
  { id: 'duo', label: 'Duo' },
];

export function Leaderboard() {
  const { session } = useAuth();
  const me = session?.user.id ?? null;
  const [mode, setMode] = useState<Mode>('solo');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    (async () => {
      const ratingsResp = await supabase
        .from('ratings')
        .select('user_id, elo, games_played')
        .eq('game', 'euchre')
        .eq('mode', mode)
        .order('elo', { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (ratingsResp.error) { setError(ratingsResp.error.message); return; }
      const ratings = (ratingsResp.data ?? []) as Array<Pick<RatingRow, 'user_id' | 'elo' | 'games_played'>>;
      if (ratings.length === 0) { setRows([]); return; }

      const ids = ratings.map((r) => r.user_id);
      const profilesResp = await supabase
        .from('profiles')
        .select('user_id, username')
        .in('user_id', ids);
      if (cancelled) return;
      const profByUid = new Map<string, string>();
      for (const p of (profilesResp.data ?? []) as Pick<ProfileRow, 'user_id' | 'username'>[]) {
        profByUid.set(p.user_id, p.username);
      }
      setRows(
        ratings.map((r) => ({
          user_id: r.user_id,
          elo: r.elo,
          games_played: r.games_played,
          username: profByUid.get(r.user_id) ?? r.user_id.slice(0, 8),
        })),
      );
    })();
    return () => { cancelled = true; };
  }, [mode]);

  return (
    <div className="min-h-full p-6 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-3xl font-bold">Leaderboard</h1>
        <Link to="/" className="text-sm hover:underline">← Lobby</Link>
      </header>

      <div className="mb-4 flex gap-2">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`rounded px-3 py-1 text-sm ${
              mode === m.id
                ? 'bg-emerald-600 text-white'
                : 'border border-slate-600 hover:bg-slate-700'
            }`}
          >
            Euchre · {m.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 rounded bg-red-900/50 border border-red-700 p-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {rows === null ? (
        <p className="text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-slate-400">No one has finished a ranked {mode} game yet. Be the first.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-slate-400 text-left">
            <tr>
              <th className="py-1 w-10 text-right pr-2">#</th>
              <th className="py-1">Player</th>
              <th className="py-1 text-right">ELO</th>
              <th className="py-1 text-right">Games</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isMe = r.user_id === me;
              return (
                <tr
                  key={r.user_id}
                  className={`border-t border-slate-700 ${isMe ? 'bg-emerald-950/30' : ''}`}
                >
                  <td className="py-2 text-right pr-2 tabular-nums text-slate-400">{i + 1}</td>
                  <td className="py-2 font-medium">
                    {r.username}
                    {isMe && <span className="ml-2 text-xs text-emerald-400">(you)</span>}
                  </td>
                  <td className="py-2 text-right tabular-nums">{r.elo}</td>
                  <td className="py-2 text-right tabular-nums text-slate-400">{r.games_played}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="mt-4 text-xs text-slate-500">
        K=32 for the first 10 ranked games, then K=16. Private-room games don't count.
      </p>
    </div>
  );
}
