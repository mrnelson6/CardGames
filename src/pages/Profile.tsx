import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { EloHistoryRow, ProfileRow, RatingRow } from '../lib/database.types';

type Rating = Pick<RatingRow, 'game' | 'mode' | 'elo' | 'games_played'>;
type HistoryEntry = Pick<EloHistoryRow, 'id' | 'game' | 'mode' | 'game_id' | 'rating_before' | 'rating_after' | 'delta' | 'created_at'>;

interface UserStats {
  games_played: number;
  games_won: number;
  first_game_at: string | null;
  tricks_won: number;
  total_tricks: number;
  hands_played: number;
  trump_called: number;
  trump_called_set: number;
  loners_won: number;
  marches_won: number;
  most_played_with: { user_id: string; username: string; games: number } | null;
  highest_beaten: { user_id: string; username: string; rating: number } | null;
  favorite_trump: { suit: 'C' | 'D' | 'H' | 'S'; count: number } | null;
}

const USERNAME_RE = /^[A-Za-z0-9_]+$/;

const SUIT_LABEL: Record<string, string> = {
  C: '♣ Clubs',
  D: '♦ Diamonds',
  H: '♥ Hearts',
  S: '♠ Spades',
};

function formatPct(num: number, denom: number): string {
  if (denom === 0) return '—';
  return `${Math.round((num / denom) * 100)}%`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

export function Profile() {
  const { session } = useAuth();
  const me = session?.user.id ?? null;

  const [profile, setProfile] = useState<Pick<ProfileRow, 'username'> | null>(null);
  const [ratings, setRatings] = useState<Rating[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!me) return;
    Promise.all([
      supabase.from('profiles').select('username').eq('user_id', me).maybeSingle(),
      supabase.from('ratings').select('game,mode,elo,games_played').eq('user_id', me),
      supabase
        .from('elo_history')
        .select('id,game,mode,game_id,rating_before,rating_after,delta,created_at')
        .eq('user_id', me)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase.rpc('get_user_stats' as never, { p_user: me } as never),
    ]).then(([p, r, h, s]) => {
      if (p.error) setError(p.error.message);
      else setProfile(p.data as Pick<ProfileRow, 'username'> | null);
      if (r.error) setError(r.error.message);
      setRatings((r.data ?? []) as Rating[]);
      if (h.error) setError(h.error.message);
      setHistory((h.data ?? []) as HistoryEntry[]);
      if (s.error) setError(s.error.message);
      else setStats((s.data as UserStats) ?? null);
    });
  }, [me]);

  const startEdit = () => {
    setDraft(profile?.username ?? '');
    setEditing(true);
    setError(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft('');
    setError(null);
  };

  const saveUsername = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me) return;
    const next = draft.trim();
    if (next.length < 3 || next.length > 24) {
      setError('Username must be 3–24 characters.');
      return;
    }
    if (!USERNAME_RE.test(next)) {
      setError('Letters, numbers, and underscores only.');
      return;
    }
    setSaving(true);
    setError(null);
    const upd = await (supabase.from('profiles') as unknown as {
      update: (v: { username: string }) => {
        eq: (col: string, val: string) => Promise<{ error: { code?: string; message: string } | null }>;
      };
    }).update({ username: next }).eq('user_id', me);
    setSaving(false);
    if (upd.error) {
      if (upd.error.code === '23505') setError('That username is already taken.');
      else setError(upd.error.message);
      return;
    }
    setProfile({ username: next });
    setEditing(false);
  };

  return (
    <div className="min-h-full p-6 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Profile</h1>
        <Link to="/" className="text-sm hover:underline">← Lobby</Link>
      </header>

      {error && (
        <div className="mb-3 rounded bg-red-900/50 border border-red-700 p-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="mb-6 rounded-lg bg-slate-800 p-4">
        <p className="text-xs text-slate-400 mb-1">Username</p>
        {editing ? (
          <form onSubmit={saveUsername} className="flex flex-wrap gap-2 items-center">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={24}
              className="rounded border border-slate-600 bg-slate-900 px-3 py-1 font-mono"
              placeholder="3-24 chars, A-Z 0-9 _"
            />
            <button
              type="submit"
              disabled={saving || draft.trim().length < 3}
              className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1 text-sm disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={saving}
              className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1 text-sm"
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-2xl font-mono">{profile?.username ?? '…'}</span>
            <button
              onClick={startEdit}
              className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1 text-sm"
            >
              Change
            </button>
            <span className="text-xs text-slate-500">
              Friends use this to send you requests.
            </span>
          </div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Lifetime stats</h2>
        {stats === null ? (
          <p className="text-slate-400 text-sm">Loading…</p>
        ) : stats.games_played === 0 ? (
          <p className="text-slate-400 text-sm">No completed games yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat label="Games played" value={stats.games_played} />
            <Stat
              label="Games won"
              value={stats.games_won}
              sub={`${formatPct(stats.games_won, stats.games_played)} win rate`}
            />
            <Stat
              label="Tricks won"
              value={stats.tricks_won}
              sub={`${formatPct(stats.tricks_won, stats.total_tricks)} of ${stats.total_tricks}`}
            />
            <Stat label="Hands played" value={stats.hands_played} />
            <Stat
              label="Times called trump"
              value={stats.trump_called}
              sub={
                stats.trump_called > 0
                  ? `${formatPct(stats.trump_called_set, stats.trump_called)} got set`
                  : undefined
              }
            />
            <Stat label="Got set as caller" value={stats.trump_called_set} />
            <Stat label="Loners won" value={stats.loners_won} />
            <Stat label="Marches won" value={stats.marches_won} />
            <Stat
              label="First game"
              value={formatDate(stats.first_game_at)}
              small
            />
            <Stat
              label="Most played with"
              value={stats.most_played_with?.username ?? '—'}
              sub={
                stats.most_played_with
                  ? `${stats.most_played_with.games} games`
                  : undefined
              }
              small
            />
            <Stat
              label="Best opponent beaten"
              value={stats.highest_beaten?.username ?? '—'}
              sub={
                stats.highest_beaten
                  ? `ELO ${stats.highest_beaten.rating}`
                  : undefined
              }
              small
            />
            <Stat
              label="Favorite trump"
              value={stats.favorite_trump ? SUIT_LABEL[stats.favorite_trump.suit] : '—'}
              sub={
                stats.favorite_trump
                  ? `${stats.favorite_trump.count} calls`
                  : undefined
              }
              small
            />
          </div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Ratings</h2>
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

function Stat({
  label,
  value,
  sub,
  small,
}: {
  label: string;
  value: string | number;
  sub?: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div
        className={`font-semibold tabular-nums ${
          small ? 'text-base' : 'text-2xl'
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}
