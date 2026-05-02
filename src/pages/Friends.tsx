import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { subscribeWithReconnect } from '../lib/realtime';
import { useAuth } from '../lib/auth';
import { euchreApi } from '../games/euchre/api';
import type { ProfileRow } from '../lib/database.types';

interface FriendRequest {
  from_user: string;
  to_user: string;
  created_at: string;
}

interface Friendship {
  user_a: string;
  user_b: string;
}

export function Friends() {
  const { session } = useAuth();
  const me = session?.user.id ?? null;

  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [friends, setFriends] = useState<Friendship[]>([]);
  const [usernames, setUsernames] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [partyState, setPartyState] = useState<{
    party_id: string;
    is_leader: boolean;
    member_count: number;
  } | null>(null);

  // Initial load
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    (async () => {
      const [reqs, fr] = await Promise.all([
        supabase.from('friend_requests').select('*'),
        supabase.from('friendships').select('*'),
      ]);
      if (cancelled) return;
      const reqRows = (reqs.data ?? []) as FriendRequest[];
      setIncoming(reqRows.filter((r) => r.to_user === me));
      setOutgoing(reqRows.filter((r) => r.from_user === me));
      setFriends((fr.data ?? []) as Friendship[]);
    })();
    return () => { cancelled = true; };
  }, [me]);

  // Track caller's party so we can show "Invite" buttons.
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    const refreshParty = async () => {
      const { data: membership } = await supabase
        .from('party_members')
        .select('party_id')
        .eq('user_id', me)
        .maybeSingle();
      if (cancelled) return;
      if (!membership) { setPartyState(null); return; }
      const pid = (membership as { party_id: string }).party_id;
      const { data: p } = await supabase
        .from('parties')
        .select('id, leader_id')
        .eq('id', pid)
        .maybeSingle();
      const { data: members } = await supabase
        .from('party_members')
        .select('user_id')
        .eq('party_id', pid);
      if (cancelled || !p) return;
      const partyRow = p as { id: string; leader_id: string };
      setPartyState({
        party_id: partyRow.id,
        is_leader: partyRow.leader_id === me,
        member_count: ((members ?? []) as unknown[]).length,
      });
    };
    refreshParty();
    const unsub = subscribeWithReconnect({
      channel: `friends-party-${me}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'party_members' },
          refreshParty,
        ).on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'parties' },
          refreshParty,
        ),
    });
    return () => { cancelled = true; unsub(); };
  }, [me]);

  // Realtime: friend_requests + friendships changes affecting me.
  useEffect(() => {
    if (!me) return;
    const refreshReqs = () =>
      supabase
        .from('friend_requests')
        .select('*')
        .then(({ data }) => {
          const rows = (data ?? []) as FriendRequest[];
          setIncoming(rows.filter((r) => r.to_user === me));
          setOutgoing(rows.filter((r) => r.from_user === me));
        });
    const refreshFriends = () =>
      supabase
        .from('friendships')
        .select('*')
        .then(({ data }) => setFriends((data ?? []) as Friendship[]));

    const unsubR = subscribeWithReconnect({
      channel: `friend-reqs-${me}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'friend_requests' },
          refreshReqs,
        ),
    });
    const unsubF = subscribeWithReconnect({
      channel: `friendships-${me}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'friendships' },
          refreshFriends,
        ),
    });
    return () => {
      unsubR();
      unsubF();
    };
  }, [me]);

  // Resolve usernames for everyone in the lists.
  useEffect(() => {
    const ids = new Set<string>();
    for (const r of incoming) ids.add(r.from_user);
    for (const r of outgoing) ids.add(r.to_user);
    for (const f of friends) {
      ids.add(f.user_a);
      ids.add(f.user_b);
    }
    const missing = Array.from(ids).filter((id) => !usernames.has(id));
    if (missing.length === 0) return;
    supabase
      .from('profiles')
      .select('user_id, username')
      .in('user_id', missing)
      .then(({ data }) => {
        if (!data) return;
        setUsernames((prev) => {
          const next = new Map(prev);
          for (const r of data as Pick<ProfileRow, 'user_id' | 'username'>[]) {
            next.set(r.user_id, r.username);
          }
          return next;
        });
      });
  }, [incoming, outgoing, friends]);

  const flash = (msg: string) => {
    setInfo(msg);
    setTimeout(() => setInfo((cur) => (cur === msg ? null : cur)), 3000);
  };

  const sendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me || !search.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const username = search.trim();
      const profilesResp = await supabase
        .from('profiles')
        .select('user_id, username')
        .ilike('username', username)
        .maybeSingle();
      const target = profilesResp.data as Pick<ProfileRow, 'user_id' | 'username'> | null;
      if (profilesResp.error) throw new Error(profilesResp.error.message);
      if (!target) throw new Error(`No user named "${username}"`);
      if (target.user_id === me) throw new Error("That's you.");

      // If we're already friends, bail.
      const lo = me < target.user_id ? me : target.user_id;
      const hi = me < target.user_id ? target.user_id : me;
      const friendResp = await supabase
        .from('friendships')
        .select('user_a')
        .eq('user_a', lo)
        .eq('user_b', hi)
        .maybeSingle();
      if (friendResp.data) throw new Error('Already friends.');

      const insErr = await (supabase.from('friend_requests') as unknown as {
        insert: (v: { from_user: string; to_user: string }) => Promise<{ error: { code?: string; message: string } | null }>;
      }).insert({ from_user: me, to_user: target.user_id });
      if (insErr.error) {
        if (insErr.error.code === '23505') throw new Error('Request already sent.');
        throw new Error(insErr.error.message);
      }
      flash(`Friend request sent to ${target.username}.`);
      setSearch('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const acceptRequest = async (fromUser: string) => {
    setBusy(true);
    setError(null);
    try {
      const { error } = await (supabase.rpc as unknown as (
        fn: string,
        args: { p_from_user: string },
      ) => Promise<{ error: { message: string } | null }>)('accept_friend_request', {
        p_from_user: fromUser,
      });
      if (error) throw new Error(error.message);
      flash('Friend added.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeRow = async <T extends Record<string, string>>(
    table: 'friend_requests' | 'friendships',
    match: T,
  ) => {
    setBusy(true);
    setError(null);
    try {
      let q = supabase.from(table).delete();
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
      const { error } = await q;
      if (error) throw new Error(error.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const otherUserOf = (f: Friendship): string => (f.user_a === me ? f.user_b : f.user_a);

  const inviteToParty = async (toUser: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await euchreApi.inviteToParty(toUser);
      flash(r.already_member ? 'Already in your party.' : 'Invited!');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canInvite = partyState !== null && partyState.is_leader && partyState.member_count < 2;

  return (
    <div className="min-h-full p-6 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Friends</h1>
        <Link to="/" className="text-sm hover:underline">← Lobby</Link>
      </header>

      {error && (
        <div className="mb-3 rounded bg-red-900/50 border border-red-700 p-2 text-sm text-red-200">
          {error}
        </div>
      )}
      {info && (
        <div className="mb-3 rounded bg-emerald-900/40 border border-emerald-700 p-2 text-sm text-emerald-200">
          {info}
        </div>
      )}

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Add a friend</h2>
        <form onSubmit={sendRequest} className="flex gap-2 max-w-sm">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="username"
            className="flex-1 rounded border border-slate-600 bg-slate-900 px-3 py-2"
          />
          <button
            type="submit"
            disabled={busy || !search.trim()}
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </section>

      {incoming.length > 0 && (
        <section className="mb-6">
          <h2 className="text-lg font-semibold mb-2">Incoming requests</h2>
          <ul className="space-y-2">
            {incoming.map((r) => (
              <li
                key={r.from_user}
                className="flex items-center justify-between rounded border border-slate-700 bg-slate-800 px-3 py-2"
              >
                <span className="font-medium">{usernames.get(r.from_user) ?? r.from_user.slice(0, 8)}</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => acceptRequest(r.from_user)}
                    disabled={busy}
                    className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1 text-sm"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => removeRow('friend_requests', { from_user: r.from_user, to_user: r.to_user })}
                    disabled={busy}
                    className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1 text-sm"
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {outgoing.length > 0 && (
        <section className="mb-6">
          <h2 className="text-lg font-semibold mb-2">Outgoing requests</h2>
          <ul className="space-y-2">
            {outgoing.map((r) => (
              <li
                key={r.to_user}
                className="flex items-center justify-between rounded border border-slate-700 bg-slate-800 px-3 py-2"
              >
                <span className="font-medium">{usernames.get(r.to_user) ?? r.to_user.slice(0, 8)}</span>
                <button
                  onClick={() => removeRow('friend_requests', { from_user: r.from_user, to_user: r.to_user })}
                  disabled={busy}
                  className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1 text-sm"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-2">Friends</h2>
        {friends.length === 0 ? (
          <p className="text-slate-400 text-sm">No friends yet.</p>
        ) : (
          <ul className="space-y-2">
            {friends.map((f) => {
              const other = otherUserOf(f);
              return (
                <li
                  key={`${f.user_a}-${f.user_b}`}
                  className="flex items-center justify-between rounded border border-slate-700 bg-slate-800 px-3 py-2"
                >
                  <span className="font-medium">{usernames.get(other) ?? other.slice(0, 8)}</span>
                  <div className="flex gap-2">
                    {canInvite && (
                      <button
                        onClick={() => inviteToParty(other)}
                        disabled={busy}
                        className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1 text-sm disabled:opacity-50"
                      >
                        Invite to party
                      </button>
                    )}
                    <button
                      onClick={() => removeRow('friendships', { user_a: f.user_a, user_b: f.user_b })}
                      disabled={busy}
                      className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1 text-sm"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
