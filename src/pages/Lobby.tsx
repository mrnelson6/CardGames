import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { subscribeWithReconnect } from '../lib/realtime';
import { useAuth } from '../lib/auth';
import { usePresence } from '../lib/presence';
import { euchreApi } from '../games/euchre/api';
import type { ProfileRow } from '../lib/database.types';

interface PartyState {
  party_id: string;
  invite_code: string;
  leader_id: string;
  members: Array<{ user_id: string; username: string }>;
}

interface FriendRow {
  user_a: string;
  user_b: string;
}

type View = 'hub' | 'duo' | 'private';

export function Lobby() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const me = session?.user.id ?? null;
  const onlineUsers = usePresence();

  // Initial view honours navigate(... { state: { view: 'duo' } }) so other
  // pages (e.g. Friends → Invite to party) can deep-link straight into
  // the duo subview.
  const [view, setView] = useState<View>(() => {
    const v = (location.state as { view?: View } | null)?.view;
    return v === 'duo' || v === 'private' || v === 'hub' ? v : 'hub';
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [party, setParty] = useState<PartyState | null>(null);
  const [partyCode, setPartyCode] = useState('');
  const [joinCode, setJoinCode] = useState('');

  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [usernames, setUsernames] = useState<Map<string, string>>(new Map());

  const loadParty = useCallback(async () => {
    if (!me) return;
    // limit(1) instead of maybeSingle() so a leftover orphan party_members
    // row from a previous failure doesn't break the whole lobby.
    const { data: memberships } = await supabase
      .from('party_members')
      .select('party_id')
      .eq('user_id', me)
      .limit(1);
    const membership = (memberships ?? [])[0];
    if (!membership) { setParty(null); return; }
    const pid = (membership as { party_id: string }).party_id;
    const { data: p } = await supabase
      .from('parties')
      .select('id, invite_code, leader_id')
      .eq('id', pid)
      .maybeSingle();
    if (!p) { setParty(null); return; }
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
  }, [me]);

  // Party state + realtime.
  useEffect(() => {
    if (!me) return;
    void loadParty();
    const unsub = subscribeWithReconnect({
      channel: `lobby-party-${me}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'party_members' },
          () => { void loadParty(); },
        ).on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'parties' },
          () => { void loadParty(); },
        ),
    });
    return () => { unsub(); };
  }, [me, loadParty]);

  // Auto-navigate when our party leader queues us.
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

  // Friends list (used by "With a friend" subview).
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    supabase
      .from('friendships')
      .select('user_a,user_b')
      .then(({ data }) => {
        if (cancelled) return;
        setFriends((data ?? []) as FriendRow[]);
      });
    return () => { cancelled = true; };
  }, [me]);

  // Resolve usernames for friends.
  useEffect(() => {
    if (!me || friends.length === 0) return;
    const ids = new Set<string>();
    for (const f of friends) {
      ids.add(f.user_a === me ? f.user_b : f.user_a);
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
  }, [friends, me]);

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const onQueueSolo = () => navigate('/games/euchre/play/solo');

  const onQueueDuo = () =>
    wrap(async () => {
      await euchreApi.enqueueMatchmaking('duo');
      navigate('/games/euchre/play/duo');
    });

  const onCreateRoom = () =>
    wrap(async () => {
      const r = await euchreApi.createRoom();
      navigate(`/games/euchre/room/${r.invite_code}`);
    });

  const onJoinRoom = (e: FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim()) return;
    wrap(async () => {
      const code = joinCode.trim().toUpperCase();
      const r = await euchreApi.joinRoom(code);
      if (r.status === 'playing') navigate(`/games/euchre/g/${r.game_id}`);
      else navigate(`/games/euchre/room/${r.invite_code}`);
    });
  };

  const onCreateParty = () => wrap(async () => {
    await euchreApi.createParty();
    // Realtime should also catch this, but reload right away so the UI
    // flips even when the broadcast is a beat behind.
    await loadParty();
  });
  const onLeaveParty = () => wrap(async () => {
    await euchreApi.leaveParty();
    await loadParty();
  });
  const onJoinPartyByCode = (e: FormEvent) => {
    e.preventDefault();
    if (!partyCode.trim()) return;
    wrap(async () => {
      await euchreApi.joinParty(partyCode.trim().toUpperCase());
      setPartyCode('');
      await loadParty();
    });
  };
  const onInviteFriend = (toUser: string) =>
    wrap(async () => { await euchreApi.inviteToParty(toUser); });
  // Convenience: in one click, create a party (if missing) and invite a
  // specific friend into it. Used from the duo-view "no party yet"
  // friends list and from the Friends page.
  const onStartPartyWith = (toUser: string) =>
    wrap(async () => {
      let havePartyAsLeader = !!party && party.leader_id === me;
      if (!havePartyAsLeader) {
        try { await euchreApi.createParty(); }
        catch (e) {
          // Idempotent fallback: if we somehow already had a party, just
          // continue to the invite step.
          if (!(e instanceof Error && /already/i.test(e.message))) throw e;
        }
        await loadParty();
        havePartyAsLeader = true;
      }
      await euchreApi.inviteToParty(toUser);
    });

  const onCreateBotGame = () =>
    wrap(async () => {
      const r = await euchreApi.createBotGame();
      navigate(`/games/euchre/g/${r.game_id}`);
    });

  const friendIds = friends.map((f) => (f.user_a === me ? f.user_b : f.user_a));
  const partyMemberIds = new Set((party?.members ?? []).map((m) => m.user_id));
  const inviteableFriends = friendIds.filter((id) => !partyMemberIds.has(id));

  return (
    <div className="min-h-full p-4 sm:p-6 max-w-4xl mx-auto">
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

      <p className="text-sm text-slate-400 mb-6">
        Signed in as <span className="text-slate-200">{session?.user.email ?? 'guest'}</span>
      </p>

      {error && (
        <div className="mb-4 rounded bg-red-900/50 border border-red-700 p-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {view === 'hub' && (
        <HubView
          party={party}
          onQuickMatch={onQueueSolo}
          onWithFriend={() => setView('duo')}
          onPrivate={() => setView('private')}
          onBots={onCreateBotGame}
          busy={busy}
        />
      )}

      {view === 'duo' && (
        <DuoView
          me={me!}
          party={party}
          friendIds={friendIds}
          inviteableFriends={inviteableFriends}
          usernames={usernames}
          onlineUsers={onlineUsers}
          partyCode={partyCode}
          setPartyCode={setPartyCode}
          onBack={() => setView('hub')}
          onCreateParty={onCreateParty}
          onLeaveParty={onLeaveParty}
          onJoinPartyByCode={onJoinPartyByCode}
          onInviteFriend={onInviteFriend}
          onStartPartyWith={onStartPartyWith}
          onQueueDuo={onQueueDuo}
          busy={busy}
        />
      )}

      {view === 'private' && (
        <PrivateView
          joinCode={joinCode}
          setJoinCode={setJoinCode}
          onBack={() => setView('hub')}
          onCreateRoom={onCreateRoom}
          onJoinRoom={onJoinRoom}
          busy={busy}
        />
      )}

      <footer className="mt-10 pt-6 border-t border-slate-800 text-xs text-slate-500 flex items-center gap-3 flex-wrap">
        <span>Practice:</span>
        <Link to="/games/euchre/hotseat" className="hover:underline">Hot-seat (4 players, one device)</Link>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

interface HubViewProps {
  party: PartyState | null;
  onQuickMatch: () => void;
  onWithFriend: () => void;
  onPrivate: () => void;
  onBots: () => void;
  busy: boolean;
}

function HubView({ party, onQuickMatch, onWithFriend, onPrivate, onBots, busy }: HubViewProps) {
  const partySize = party?.members.length ?? 0;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <ModeCard
        accent="emerald"
        title="Quick match"
        subtitle="Ranked solo"
        body="Get matched into a 4-player ranked game. Teams are balanced by rating."
        onClick={onQuickMatch}
        disabled={busy}
      />
      <ModeCard
        accent="violet"
        title="With a friend"
        subtitle="Ranked duo"
        body="Team up with one friend. You'll be matched against another duo."
        status={
          partySize === 2
            ? 'Party ready (2/2)'
            : partySize === 1
              ? 'Party started — invite 1 more'
              : null
        }
        onClick={onWithFriend}
        disabled={busy}
      />
      <ModeCard
        accent="sky"
        title="Private room"
        subtitle="Casual with friends"
        body="Create or join a 6-letter code. Up to 3 friends, bots fill the rest."
        onClick={onPrivate}
        disabled={busy}
      />
      <ModeCard
        accent="amber"
        title="Vs bots"
        subtitle="Casual practice"
        body="Jump into a game against 3 bots. No matchmaking, no waiting."
        onClick={onBots}
        disabled={busy}
      />
    </div>
  );
}

const ACCENTS: Record<string, string> = {
  emerald: 'from-emerald-500/20 to-emerald-700/5 border-emerald-700/60 hover:border-emerald-500',
  violet:  'from-violet-500/20 to-violet-700/5 border-violet-700/60 hover:border-violet-500',
  sky:     'from-sky-500/20 to-sky-700/5 border-sky-700/60 hover:border-sky-500',
  amber:   'from-amber-500/20 to-amber-700/5 border-amber-700/60 hover:border-amber-500',
};
const ACCENT_TEXT: Record<string, string> = {
  emerald: 'text-emerald-300',
  violet:  'text-violet-300',
  sky:     'text-sky-300',
  amber:   'text-amber-300',
};

function ModeCard({
  accent,
  title,
  subtitle,
  body,
  status,
  onClick,
  disabled,
}: {
  accent: keyof typeof ACCENTS;
  title: string;
  subtitle: string;
  body: string;
  status?: string | null;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-left rounded-xl bg-gradient-to-br ${ACCENTS[accent]} border-2 p-5 transition disabled:opacity-50 disabled:cursor-not-allowed group`}
    >
      <div className={`text-xs uppercase tracking-wider font-medium ${ACCENT_TEXT[accent]}`}>
        {subtitle}
      </div>
      <div className="text-2xl font-bold mt-1 mb-2">{title}</div>
      <p className="text-sm text-slate-300/90">{body}</p>
      {status && (
        <div className={`mt-3 text-xs font-medium ${ACCENT_TEXT[accent]}`}>{status}</div>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// "With a friend" subview
// ---------------------------------------------------------------------------

interface DuoViewProps {
  me: string;
  party: PartyState | null;
  friendIds: string[];
  inviteableFriends: string[];
  usernames: Map<string, string>;
  onlineUsers: Set<string>;
  partyCode: string;
  setPartyCode: (s: string) => void;
  onBack: () => void;
  onCreateParty: () => void;
  onLeaveParty: () => void;
  onJoinPartyByCode: (e: FormEvent) => void;
  onInviteFriend: (uid: string) => void;
  onStartPartyWith: (uid: string) => void;
  onQueueDuo: () => void;
  busy: boolean;
}

function DuoView(props: DuoViewProps) {
  const {
    me, party, friendIds, inviteableFriends, usernames, onlineUsers,
    partyCode, setPartyCode,
    onBack, onCreateParty, onLeaveParty, onJoinPartyByCode,
    onInviteFriend, onStartPartyWith, onQueueDuo, busy,
  } = props;

  const ready = party && party.members.length === 2;
  const isLeader = party?.leader_id === me;

  // Sort friends so online ones surface first; alphabetical inside each group.
  const sortedFriends = friendIds.slice().sort((a, b) => {
    const ao = onlineUsers.has(a) ? 0 : 1;
    const bo = onlineUsers.has(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return (usernames.get(a) ?? a).localeCompare(usernames.get(b) ?? b);
  });

  return (
    <div className="space-y-5">
      <SubHeader title="With a friend" subtitle="Ranked duo" onBack={onBack} accent="violet" />

      {!party && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-5 space-y-4">
          <p className="text-slate-300">
            Pick a friend below to start a party with them — they'll get an
            invite popup. Or start an empty party and invite later.
          </p>

          {sortedFriends.length > 0 ? (
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wider mb-2">
                Your friends
              </p>
              <ul className="space-y-1 max-h-64 overflow-y-auto pr-1">
                {sortedFriends.map((uid) => {
                  const isOnline = onlineUsers.has(uid);
                  return (
                    <li
                      key={uid}
                      className="flex items-center justify-between rounded border border-slate-700 bg-slate-900/40 px-3 py-1.5 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${
                            isOnline ? 'bg-emerald-400' : 'bg-slate-600'
                          }`}
                        />
                        <span className="font-medium">
                          {usernames.get(uid) ?? uid.slice(0, 8)}
                        </span>
                        <span className="text-xs text-slate-500">
                          {isOnline ? 'online' : 'offline'}
                        </span>
                      </span>
                      <button
                        onClick={() => onStartPartyWith(uid)}
                        disabled={busy || !isOnline}
                        title={isOnline ? 'Start a party and invite this friend' : 'Friend is offline'}
                        className="rounded bg-violet-600 hover:bg-violet-500 px-3 py-1 text-xs disabled:opacity-50"
                      >
                        Start party
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              No friends yet — <Link to="/friends" className="underline hover:text-slate-200">add some</Link>{' '}
              first, then come back here.
            </p>
          )}

          <div className="pt-3 border-t border-slate-700 flex flex-col gap-3">
            <button
              onClick={onCreateParty}
              disabled={busy}
              className="self-start rounded border border-violet-600 hover:bg-violet-600/20 px-4 py-2 text-sm disabled:opacity-50"
            >
              Create empty party
            </button>
            <div>
              <p className="text-xs text-slate-400 mb-2">Have a code from a friend?</p>
              <form onSubmit={onJoinPartyByCode} className="flex gap-2 max-w-sm">
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
                  Join
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {party && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-5 space-y-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wider">Your party</p>
              <p className="text-lg font-medium">
                {party.members.length}/2 — {ready ? 'ready to queue' : 'waiting for partner'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <code className="text-xl font-mono tracking-widest text-violet-300">{party.invite_code}</code>
              <button
                onClick={() => navigator.clipboard.writeText(party.invite_code)}
                className="rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-700"
              >
                Copy
              </button>
            </div>
          </div>

          <ul className="space-y-1 text-sm">
            {party.members.map((m) => (
              <li key={m.user_id} className="flex items-center gap-2">
                <span className="font-medium">{m.username}</span>
                {m.user_id === party.leader_id && <span className="text-amber-300 text-xs">leader</span>}
                {m.user_id === me && <span className="text-emerald-400 text-xs">(you)</span>}
              </li>
            ))}
          </ul>

          {ready && (
            <button
              onClick={onQueueDuo}
              disabled={busy || !isLeader}
              title={isLeader ? '' : 'Only the party leader can queue'}
              className="w-full rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-3 font-semibold text-lg disabled:opacity-50"
            >
              {isLeader ? 'Queue ranked duo' : 'Waiting for leader to queue'}
            </button>
          )}

          {!ready && isLeader && inviteableFriends.length > 0 && (
            <div>
              <p className="text-xs text-slate-400 mb-2">Invite a friend</p>
              <ul className="space-y-1">
                {inviteableFriends.slice(0, 8).map((uid) => {
                  const isOnline = onlineUsers.has(uid);
                  return (
                    <li key={uid} className="flex items-center justify-between rounded border border-slate-700 bg-slate-900/40 px-3 py-1.5 text-sm">
                      <span className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                        {usernames.get(uid) ?? uid.slice(0, 8)}
                      </span>
                      <button
                        onClick={() => onInviteFriend(uid)}
                        disabled={busy || !isOnline}
                        className="rounded bg-violet-600 hover:bg-violet-500 px-3 py-1 text-xs disabled:opacity-50"
                      >
                        Invite
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {!ready && !isLeader && (
            <p className="text-sm text-slate-400">Waiting on the leader to invite or queue.</p>
          )}

          {!ready && isLeader && inviteableFriends.length === 0 && (
            <p className="text-sm text-slate-400">
              No friends to invite. <Link to="/friends" className="underline hover:text-slate-200">Add a friend</Link> first,
              or share the code <code className="font-mono">{party.invite_code}</code>.
            </p>
          )}

          <button
            onClick={onLeaveParty}
            disabled={busy}
            className="rounded border border-slate-600 hover:bg-slate-700 px-3 py-1 text-sm disabled:opacity-50"
          >
            Leave party
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Private room subview
// ---------------------------------------------------------------------------

interface PrivateViewProps {
  joinCode: string;
  setJoinCode: (s: string) => void;
  onBack: () => void;
  onCreateRoom: () => void;
  onJoinRoom: (e: FormEvent) => void;
  busy: boolean;
}

function PrivateView({ joinCode, setJoinCode, onBack, onCreateRoom, onJoinRoom, busy }: PrivateViewProps) {
  return (
    <div className="space-y-5">
      <SubHeader title="Private room" subtitle="Casual with friends" onBack={onBack} accent="sky" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-5 space-y-3">
          <h3 className="text-lg font-semibold">Create a room</h3>
          <p className="text-sm text-slate-400">
            You'll get a 6-letter code. Share it with up to 3 friends. Empty seats can be filled with bots.
          </p>
          <button
            onClick={onCreateRoom}
            disabled={busy}
            className="w-full rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 disabled:opacity-50"
          >
            Create room
          </button>
        </div>

        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-5 space-y-3">
          <h3 className="text-lg font-semibold">Join with code</h3>
          <p className="text-sm text-slate-400">Got a 6-letter code from a friend?</p>
          <form onSubmit={onJoinRoom} className="flex gap-2">
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
              className="rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 disabled:opacity-50"
            >
              Join
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared subheader
// ---------------------------------------------------------------------------

function SubHeader({
  title, subtitle, onBack, accent,
}: { title: string; subtitle: string; onBack: () => void; accent: keyof typeof ACCENT_TEXT }) {
  return (
    <div className="flex items-baseline justify-between gap-3 flex-wrap">
      <div>
        <button
          onClick={onBack}
          className="text-xs text-slate-400 hover:text-slate-200 mb-1"
        >
          ← Back
        </button>
        <h2 className={`text-2xl font-bold ${ACCENT_TEXT[accent]}`}>{title}</h2>
        <p className="text-xs text-slate-400 uppercase tracking-wider">{subtitle}</p>
      </div>
    </div>
  );
}
