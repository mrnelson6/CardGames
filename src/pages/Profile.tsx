import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { EloHistoryRow, RatingRow } from '../lib/database.types';

type Rating = Pick<RatingRow, 'game' | 'mode' | 'elo' | 'games_played'>;
type HistoryEntry = Pick<EloHistoryRow, 'id' | 'game' | 'mode' | 'game_id' | 'rating_before' | 'rating_after' | 'delta' | 'created_at'>;

export function Profile() {
  const { session } = useAuth();
  const [ratings, setRatings] = useState<Rating[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      supabase
        .from('ratings')
        .select('game,mode,elo,games_played')
        .eq('user_id', session.user.id),
      supabase
        .from('elo_history')
        .select('id,game,mode,game_id,rating_before,rating_after,delta,created_at')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })
        .limit(20),
    ]).then(([r, h]) => {
      if (r.error) setError(r.error.message);
      setRatings((r.data ?? []) as Rating[]);
      if (h.error) setError(h.error.message);
      setHistory((h.data ?? []) as HistoryEntry[]);
    });
  }, [session]);

  return (
    <div className="min-h-full p-6 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Profile</h1>
        <Link to="/" className="text-sm hover:underline">← Lobby</Link>
      </header>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Ratings</h2>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {ratings === null ? (
          <p className="text-slate-400">Loading…</p>
        ) : ratings.length === 0 ? (
          <p className="text-slate-400">No ranked games yet. Win a few to start a rating.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-slate-400 text-left">
              <tr>
                <th className="py-1">Game</th>
                <th className="py-1">Mode</th>
                <th className="py-1 text-right">ELO</th>
                <th className="py-1 text-right">Games</th>
              </tr>
            </thead>
            <tbody>
              {ratings.map((r) => (
                <tr key={`${r.game}:${r.mode}`} className="border-t border-slate-700">
                  <td className="py-2 capitalize">{r.game}</td>
                  <td className="py-2 capitalize">{r.mode}</td>
                  <td className="py-2 text-right">{r.elo}</td>
                  <td className="py-2 text-right">{r.games_played}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Recent ranked games</h2>
        {history === null ? (
          <p className="text-slate-400 text-sm">Loading…</p>
        ) : history.length === 0 ? (
          <p className="text-slate-400 text-sm">No ranked history yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {history.map((h) => (
              <li
                key={h.id}
                className="flex items-center justify-between gap-3 rounded border border-slate-700 bg-slate-800 px-3 py-2"
              >
                <span className="text-slate-400 text-xs tabular-nums">
                  {new Date(h.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="capitalize">{h.game} · {h.mode}</span>
                <span className="tabular-nums">
                  {h.rating_before} → <span className="font-semibold">{h.rating_after}</span>
                </span>
                <span className={`tabular-nums font-mono ${h.delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {h.delta >= 0 ? '+' : ''}{h.delta}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
