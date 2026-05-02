import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { euchreApi } from '../games/euchre/api';

const GAMES = [
  { id: 'euchre', name: 'Euchre', enabled: true },
];

export function Lobby() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onCreateRoom = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await euchreApi.createRoom();
      navigate(`/games/euchre/room/${r.invite_code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const code = joinCode.trim().toUpperCase();
      const r = await euchreApi.joinRoom(code);
      if (r.status === 'playing') {
        navigate(`/games/euchre/g/${r.game_id}`);
      } else {
        navigate(`/games/euchre/room/${r.invite_code}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full p-6 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Lobby</h1>
        <nav className="flex items-center gap-4 text-sm">
          <Link to="/friends" className="hover:underline">Friends</Link>
          <Link to="/profile" className="hover:underline">Profile</Link>
          <button
            onClick={() => supabase.auth.signOut()}
            className="rounded border border-slate-600 px-3 py-1 hover:bg-slate-700"
          >
            Sign out
          </button>
        </nav>
      </header>

      <p className="text-sm text-slate-400 mb-4">
        Signed in as <span className="text-slate-200">{session?.user.email ?? 'guest'}</span>
      </p>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-3">Pick a game</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {GAMES.map((g) => (
            <div
              key={g.id}
              className={`rounded-lg border border-slate-700 bg-slate-800 p-4 ${
                g.enabled ? '' : 'opacity-50'
              }`}
            >
              <h3 className="text-xl font-medium mb-2">{g.name}</h3>
              {g.enabled ? (
                <div className="flex flex-wrap gap-2">
                  <Link
                    to={`/games/${g.id}/play/solo`}
                    className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm"
                  >
                    Solo queue
                  </Link>
                  <Link
                    to={`/games/${g.id}/play/duo`}
                    className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm"
                  >
                    Duo queue
                  </Link>
                  <button
                    onClick={onCreateRoom}
                    disabled={busy}
                    className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    {busy ? 'Creating…' : 'Create private room'}
                  </button>
                  <Link
                    to={`/games/${g.id}/hotseat`}
                    className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1.5 text-sm"
                  >
                    Hot-seat (practice)
                  </Link>
                </div>
              ) : (
                <p className="text-sm text-slate-400">Coming soon</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Join with code</h2>
        <form onSubmit={onJoinRoom} className="flex gap-2 max-w-sm">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="6-letter code"
            maxLength={6}
            className="flex-1 rounded border border-slate-600 bg-slate-900 px-3 py-2 uppercase tracking-widest"
          />
          <button
            type="submit"
            disabled={busy || joinCode.trim().length !== 6}
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 disabled:opacity-50"
          >
            Join
          </button>
        </form>
      </section>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
    </div>
  );
}
