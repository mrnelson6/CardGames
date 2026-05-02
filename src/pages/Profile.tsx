import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

interface Rating {
  game: string;
  mode: string;
  elo: number;
  games_played: number;
}

export function Profile() {
  const { session } = useAuth();
  const [ratings, setRatings] = useState<Rating[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    supabase
      .from('ratings')
      .select('game,mode,elo,games_played')
      .eq('user_id', session.user.id)
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setRatings(data ?? []);
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
    </div>
  );
}
