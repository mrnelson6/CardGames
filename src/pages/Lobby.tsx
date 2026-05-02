import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { subscribeWithReconnect } from '../lib/realtime';
import { useAuth } from '../lib/auth';
import { euchreApi } from '../games/euchre/api';
import type { ProfileRow } from '../lib/database.types';

const GAMES = [{ id: 'euchre', name: 'Euchre', enabled: true }];

interface PartyState {
  party_id: string;
  invite_code: string;
  leader_id: string;
  members: Array<{ user_id: string; username: string }>;
}

export function Lobby() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const me = session?.user.id ?? null;

  const [busy, setBusy] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [partyCode, setPartyCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [party, setParty] = useState<PartyState | null>(null);

  // Load current party on mount + subscribe to membership changes.
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    const load = async () => {
      const { data: membership } = await supabase
        .from('party_members')
        .select('party_id')
        .eq('user_id', me)
        .maybeSingle();
      if (cancelled) return;
      if (!membership) { setParty(null); return; }
      const pid = (membership as { party_id: string }).party_id;
      const { data: p } = await supabase
        .from('parties')
        .select('id, invite_code, leader_id')
        .eq('id', pid)
        .maybeSingle();
      if (cancelled || !p) return;
      const { data: members } = await supabase
        .from('party_members')
        .select('user_id')
        .eq('party_id', pid);
      const memberIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
      const { data: profs } = await supabase
        .from('profiles')
        .select('user_id, username')
        .in('user_id', memberIds);
      const profByUid = new Map<string, string>();
      for (const r of (profs ?? []) as Pick<ProfileRow, 'user_id' | 'username'>[]) {
        profByUid.set(r.user_id, r.username);
      }
      const partyRow = p as { id: string; invite_code: string; leader_id: string };
      setParty({
        party_id: partyRow.id,
        invite_code: partyRow.invite_code,
        leader_id: partyRow.leader_id,
        members: memberIds.map((uid) => ({
          user_id: uid,
          username: profByUid.get(uid) ?? uid.slice(0, 8),
        })),
      });
    };
    load();
    const unsub = subscribeWithReconnect({
      channel: `lobby-party-${me}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'party_members' },
          () => load(),
        ).on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'parties' },
          () => load(),
        ),
    });
    return () => { cancelled = true; unsub(); };
  }, [me]);

  // Auto-navigate to the queue page when our party leader queues us.
  useEffect(() => {
    if (!me) return;
    const unsub = subscribeWithReconnect({
      channel: `lobby-mmqueue-${me}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'mm_queue', filter: `user_id=eq.${me}` },
          (payload) => {
            const row = payload.new as { mode: string };
            if (row.mode === 'duo') navigate('/games/euchre/play/duo');
            else if (row.mode === 'solo') navigate('/games/euchre/play/solo');
          },
        ),
    });
    return () => unsub();
  }, [me, navigate]);

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const onCreateRoom = () =>
    wrap(async () => {
      const r = await euchreApi.createRoom();
      navigate(`/games/euchre/room/${r.invite_code}`);
    });

  const onJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim()) return;
    wrap(async () => {
      const code = joinCode.trim().toUpperCase();
      const r = await euchreApi.joinRoom(code);
      if (r.status === 'playing') navigate(`/games/euchre/g/${r.game_id}`);
      else navigate(`/games/euchre/room/${r.invite_code}`);
    });
  };

  const onCreateParty = () =>
    wrap(async () => { await euchreApi.createParty(); });

  const onJoinParty = (e: React.FormEvent) => {
    e.preventDefault();
    if (!partyCode.trim()) return;
    wrap(async () => {
      await euchreApi.joinParty(partyCode.trim().toUpperCase());
      setPartyCode('');
    });
  };

  const onLeaveParty = () => wrap(async () => { await euchreApi.leaveParty(); });

  const onQueueDuo = () =>
    wrap(async () => {
      await euchreApi.enqueueMatchmaking('duo');
      navigate('/games/euchre/play/duo');
    });

  return (
    <div className="min-h-full p-6 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <h1 className="text-3xl font-bold">Lobby</h1>
        <nav className="flex items-center gap-3 text-sm flex-wrap">
          <Link to="/leaderboard" className="hover:underline">Leaderboard</Link>
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
        {GAMES.map((g) => (
          <div
            key={g.id}
            className={`rounded-lg border border-slate-700 bg-slate-800 p-4 ${g.enabled ? '' : 'opacity-50'}`}
          >
            <h3 className="text-xl font-medium mb-2">{g.name}</h3>
            {g.enabled ? (
              <div className="flex flex-wrap gap-2">
                <Link to={`/games/${g.id}/play/solo`} className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm">
                  Solo queue
                </Link>
                {party && party.members.length === 2 ? (
                  <button
                    onClick={onQueueDuo}
                    disabled={busy}
                    className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    Duo queue (party of 2)
                  </button>
                ) : (
                  <span className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-500">
                    Duo queue (need party of 2)
                  </span>
                )}
                <button
                  onClick={onCreateRoom}
                  disabled={busy}
                  className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  {busy ? 'Working…' : 'Create private room'}
                </button>
                <Link to={`/games/${g.id}/hotseat`} className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1.5 text-sm">
                  Hot-seat (practice)
                </Link>
              </div>
            ) : (
              <p className="text-sm text-slate-400">Coming soon</p>
            )}
          </div>
        ))}
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-3">Party</h2>
        {party ? (
          <div className="rounded-lg border border-slate-700 bg-slate-800 p-4 space-y-3">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className="text-sm text-slate-400">Code:</span>
              <code className="text-2xl font-mono tracking-widest text-emerald-300">{party.invite_code}</code>
              <button
                onClick={() => navigator.clipboard.writeText(party.invite_code)}
                className="rounded border border-slate-600 px-3 py-1 text-xs hover:bg-slate-700"
              >
                Copy
              </button>
            </div>
            <ul className="text-sm space-y-1">
              {party.members.map((m) => (
                <li key={m.user_id}>
                  <span className="font-medium">{m.username}</span>
                  {m.user_id === party.leader_id && <span className="text-amber-300 ml-2 text-xs">leader</span>}
                  {m.user_id === me && <span className="text-emerald-400 ml-2 text-xs">(you)</span>}
                </li>
              ))}
            </ul>
            <button
              onClick={onLeaveParty}
              disabled={busy}
              className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1 text-sm disabled:opacity-50"
            >
              Leave party
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <button
              onClick={onCreateParty}
              disabled={busy}
              className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create party'}
            </button>
            <form onSubmit={onJoinParty} className="flex gap-2 max-w-sm">
              <input
                value={partyCode}
                onChange={(e) => setPartyCode(e.target.value.toUpperCase())}
                placeholder="party code"
                maxLength={6}
                className="flex-1 rounded border border-slate-600 bg-slate-900 px-3 py-2 uppercase tracking-widest"
              />
              <button
                type="submit"
                disabled={busy || partyCode.trim().length !== 6}
                className="rounded border border-slate-600 hover:bg-slate-700 px-4 py-2 disabled:opacity-50"
              >
                Join party
              </button>
            </form>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Join private room with code</h2>
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
