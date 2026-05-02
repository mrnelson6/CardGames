import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { EloHistoryRow, ProfileRow, RatingRow } from '../lib/database.types';

type Rating = Pick<RatingRow, 'game' | 'mode' | 'elo' | 'games_played'>;
type HistoryEntry = Pick<EloHistoryRow, 'id' | 'game' | 'mode' | 'game_id' | 'rating_before' | 'rating_after' | 'delta' | 'created_at'>;

const USERNAME_RE = /^[A-Za-z0-9_]+$/;

export function Profile() {
  const { session } = useAuth();
  const me = session?.user.id ?? null;

  const [profile, setProfile] = useState<Pick<ProfileRow, 'username'> | null>(null);
  const [ratings, setRatings] = useState<Rating[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
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
    ]).then(([p, r, h]) => {
      if (p.error) setError(p.error.message);
      else setProfile(p.data as Pick<ProfileRow, 'username'> | null);
      if (r.error) setError(r.error.message);
      setRatings((r.data ?? []) as Rating[]);
      if (h.error) setError(h.error.message);
      setHistory((h.data ?? []) as HistoryEntry[]);
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
