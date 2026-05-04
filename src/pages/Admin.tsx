import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

interface PlayerSlot {
  seat: number;
  is_bot: boolean;
  username: string | null;
}

interface ActiveGame {
  id: string;
  game: string;
  mode: string | null;
  team0_score: number;
  team1_score: number;
  created_at: string;
  updated_at: string;
  players: PlayerSlot[];
}

interface RatingRow {
  game: string;
  mode: string;
  username: string;
  elo: number;
  games_played: number;
}

interface FinishedGame {
  id: string;
  game: string;
  mode: string | null;
  team0_score: number;
  team1_score: number;
  updated_at: string;
}

interface RecentUser {
  username: string;
  created_at: string;
}

interface AdminStats {
  generated_at: string;
  active_games: number;
  active_by_game: Record<string, number>;
  active_by_mode: Record<string, number>;
  lobby_games: number;
  finished_games: number;
  abandoned_games: number;
  finished_by_game: Record<string, number>;
  total_users: number;
  new_users_24h: number;
  new_users_7d: number;
  active_parties: number;
  matchmaking_queue: number;
  total_hands_played: number;
  total_tricks: number;
  ranked_games_played: number;
  active_games_detail: ActiveGame[];
  top_ratings: RatingRow[];
  recent_finished: FinishedGame[];
  recent_users: RecentUser[];
}

const REFRESH_MS = 15_000;

export function Admin() {
  const { session } = useAuth();
  const me = session?.user.id ?? null;
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<number>(0);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    const load = async () => {
      const { data, error } = await supabase.rpc('admin_stats' as never);
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
      setStats(data as AdminStats);
      setRefreshedAt(Date.now());
      setLoading(false);
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [me]);

  if (loading) {
    return <div className="p-6 text-slate-400">Loading admin stats…</div>;
  }

  if (error) {
    return (
      <div className="min-h-full p-6 max-w-2xl mx-auto">
        <header className="flex items-center justify-between mb-4">
          <h1 className="text-3xl font-bold">Admin</h1>
          <Link to="/" className="text-sm hover:underline">← Lobby</Link>
        </header>
        <div className="rounded bg-red-900/50 border border-red-700 p-3 text-sm text-red-200">
          {/not_admin/i.test(error) ? 'You are not the admin user.' : error}
        </div>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="min-h-full p-4 sm:p-6 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="text-3xl font-bold">Admin</h1>
          <p className="text-xs text-slate-500">
            Updated {new Date(refreshedAt).toLocaleTimeString()} · auto-refresh {REFRESH_MS / 1000}s
          </p>
        </div>
        <Link to="/" className="text-sm hover:underline">← Lobby</Link>
      </header>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Live</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Active games" value={stats.active_games} />
          <Stat label="Lobby rooms" value={stats.lobby_games} />
          <Stat label="MM queue" value={stats.matchmaking_queue} />
          <Stat label="Active parties" value={stats.active_parties} />
        </div>
        {Object.keys(stats.active_by_game).length > 0 && (
          <p className="text-xs text-slate-400 mt-2">
            By game:{' '}
            {Object.entries(stats.active_by_game)
              .map(([g, n]) => `${g} ${n}`)
              .join(' · ')}
            {' · '}
            By mode:{' '}
            {Object.entries(stats.active_by_mode)
              .map(([m, n]) => `${m} ${n}`)
              .join(' · ')}
          </p>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Lifetime</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Total users" value={stats.total_users} />
          <Stat label="New (24h)" value={stats.new_users_24h} />
          <Stat label="New (7d)" value={stats.new_users_7d} />
          <Stat label="Finished games" value={stats.finished_games} />
          <Stat label="Hands played" value={stats.total_hands_played} />
          <Stat label="Tricks played" value={stats.total_tricks} />
          <Stat label="Ranked games" value={stats.ranked_games_played} />
          <Stat label="Abandoned" value={stats.abandoned_games} />
        </div>
        {Object.keys(stats.finished_by_game).length > 0 && (
          <p className="text-xs text-slate-400 mt-2">
            Finished by game:{' '}
            {Object.entries(stats.finished_by_game)
              .map(([g, n]) => `${g} ${n}`)
              .join(' · ')}
          </p>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">
          Active games ({stats.active_games_detail.length}
          {stats.active_games_detail.length === stats.active_games ? '' : ` of ${stats.active_games}`})
        </h2>
        {stats.active_games_detail.length === 0 ? (
          <p className="text-slate-400 text-sm">No games in progress.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {stats.active_games_detail.map((g) => (
              <li
                key={g.id}
                className="rounded border border-slate-700 bg-slate-800/60 p-3 flex items-baseline justify-between gap-3 flex-wrap"
              >
                <div>
                  <div className="font-medium">
                    <span className="capitalize">{g.game}</span>
                    <span className="text-slate-400 text-xs ml-2">{g.mode ?? 'casual'}</span>
                    <span className="text-slate-500 text-xs ml-2 tabular-nums">
                      {g.team0_score}–{g.team1_score}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {g.players
                      .map((p) =>
                        p.is_bot ? '[bot]' : p.username ?? `seat ${p.seat}`,
                      )
                      .join(' · ')}
                  </div>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">
                  {g.id.slice(0, 8)}…
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Top ratings</h2>
        {stats.top_ratings.length === 0 ? (
          <p className="text-slate-400 text-sm">No rated players yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-slate-400 text-left">
              <tr>
                <th className="py-1">Player</th>
                <th className="py-1">Game</th>
                <th className="py-1">Mode</th>
                <th className="py-1 text-right">ELO</th>
                <th className="py-1 text-right">Games</th>
              </tr>
            </thead>
            <tbody>
              {stats.top_ratings.map((r, i) => (
                <tr key={`${r.username}-${r.game}-${r.mode}-${i}`} className="border-t border-slate-700">
                  <td className="py-1.5 font-medium">{r.username}</td>
                  <td className="py-1.5 capitalize">{r.game}</td>
                  <td className="py-1.5 capitalize">{r.mode}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.elo}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.games_played}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div>
          <h2 className="text-lg font-semibold mb-2">Recent games</h2>
          {stats.recent_finished.length === 0 ? (
            <p className="text-slate-400 text-sm">None yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {stats.recent_finished.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between rounded border border-slate-700 bg-slate-800/60 px-3 py-1.5"
                >
                  <span>
                    <span className="capitalize">{g.game}</span>
                    <span className="text-slate-400 text-xs ml-2">{g.mode ?? 'casual'}</span>
                  </span>
                  <span className="text-xs text-slate-400 tabular-nums">
                    {g.team0_score}–{g.team1_score}
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {new Date(g.updated_at).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2 className="text-lg font-semibold mb-2">Recent signups</h2>
          {stats.recent_users.length === 0 ? (
            <p className="text-slate-400 text-sm">None.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {stats.recent_users.map((u) => (
                <li
                  key={u.username}
                  className="flex items-center justify-between rounded border border-slate-700 bg-slate-800/60 px-3 py-1.5"
                >
                  <span className="font-medium">{u.username}</span>
                  <span className="text-[10px] text-slate-500">
                    {new Date(u.created_at).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
