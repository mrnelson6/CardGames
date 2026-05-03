// App-level toast that listens for incoming game and party invitations
// (and one-shot notifications like "X declined your invite") and offers
// Accept / Decline. Mounted in App.tsx so it works on every authenticated
// page.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { subscribeWithReconnect } from '../lib/realtime';
import { useAuth } from '../lib/auth';
import { euchreApi } from '../games/euchre/api';
import type {
  GameInviteRow,
  NotificationRow,
  PartyInviteRow,
  ProfileRow,
} from '../lib/database.types';

type Kind = 'game' | 'party';
interface Invite {
  kind: Kind;
  id: string;
  from_user: string;
  from_username: string | null;
  game_id?: string;
  game_invite_code?: string;
  party_id?: string;
}

interface Notice {
  id: string;
  text: string;
  ts: number; // for auto-dismiss
}

export function InviteNotifier() {
  const { session } = useAuth();
  const me = session?.user.id ?? null;
  const navigate = useNavigate();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Invites subscription.
  useEffect(() => {
    if (!me) { setInvites([]); return; }

    const refresh = async () => {
      const [gameResp, partyResp] = await Promise.all([
        supabase
          .from('game_invites')
          .select('*')
          .eq('to_user', me)
          .order('created_at', { ascending: false }),
        supabase
          .from('party_invites')
          .select('*')
          .eq('to_user', me)
          .order('created_at', { ascending: false }),
      ]);
      const games = (gameResp.data ?? []) as GameInviteRow[];
      const parties = (partyResp.data ?? []) as PartyInviteRow[];

      const senderIds = new Set<string>();
      games.forEach((r) => senderIds.add(r.from_user));
      parties.forEach((r) => senderIds.add(r.from_user));
      const nameByUser = new Map<string, string>();
      if (senderIds.size > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('user_id, username')
          .in('user_id', Array.from(senderIds));
        for (const p of (profs ?? []) as Pick<ProfileRow, 'user_id' | 'username'>[]) {
          nameByUser.set(p.user_id, p.username);
        }
      }

      const merged: Invite[] = [
        ...games.map((r) => ({
          kind: 'game' as const,
          id: r.id,
          from_user: r.from_user,
          from_username: nameByUser.get(r.from_user) ?? null,
          game_id: r.game_id,
          game_invite_code: r.invite_code,
        })),
        ...parties.map((r) => ({
          kind: 'party' as const,
          id: r.id,
          from_user: r.from_user,
          from_username: nameByUser.get(r.from_user) ?? null,
          party_id: r.party_id,
        })),
      ];
      setInvites(merged);
    };
    refresh();

    const unsubGame = subscribeWithReconnect({
      channel: `game-invites-${me}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'game_invites', filter: `to_user=eq.${me}` },
          refresh,
        ),
    });
    const unsubParty = subscribeWithReconnect({
      channel: `party-invites-${me}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'party_invites', filter: `to_user=eq.${me}` },
          refresh,
        ),
    });
    return () => { unsubGame(); unsubParty(); };
  }, [me]);

  // Notifications subscription (decline notices etc).
  useEffect(() => {
    if (!me) { setNotices([]); return; }

    const onRow = (row: NotificationRow) => {
      const text = renderNotificationText(row);
      if (!text) return;
      setNotices((prev) => [...prev, { id: row.id, text, ts: Date.now() }]);
      // Auto-clean from server too so we don't accumulate stale rows.
      void supabase.from('notifications').delete().eq('id', row.id);
    };

    // Pull anything that arrived while we were offline / on a different page.
    void supabase
      .from('notifications')
      .select('*')
      .eq('user_id', me)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        for (const r of (data ?? []) as NotificationRow[]) onRow(r);
      });

    const unsub = subscribeWithReconnect({
      channel: `notifs-${me}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${me}` },
          (payload) => onRow(payload.new as NotificationRow),
        ),
    });
    return () => { unsub(); };
  }, [me]);

  // Auto-dismiss notification toasts after 5s.
  useEffect(() => {
    if (notices.length === 0) return;
    const timer = setInterval(() => {
      const cutoff = Date.now() - 5000;
      setNotices((prev) => {
        const next = prev.filter((n) => n.ts > cutoff);
        return next.length === prev.length ? prev : next;
      });
    }, 500);
    return () => clearInterval(timer);
  }, [notices.length]);

  const accept = async (inv: Invite) => {
    setBusyId(inv.id);
    setError(null);
    // Close the toast immediately — even if the network call is slow,
    // the user has already made their choice.
    setInvites((prev) => prev.filter((i) => i.id !== inv.id));
    try {
      if (inv.kind === 'game') {
        const r = await euchreApi.acceptGameInvite(inv.id);
        if (r.status === 'playing') navigate(`/games/euchre/g/${r.game_id}`);
        else navigate(`/games/euchre/room/${r.invite_code}`);
      } else {
        await euchreApi.acceptPartyInvite(inv.id);
        navigate('/');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const decline = async (inv: Invite) => {
    setBusyId(inv.id);
    setError(null);
    setInvites((prev) => prev.filter((i) => i.id !== inv.id));
    try {
      await euchreApi.declineInvite(inv.kind, inv.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (!me || (invites.length === 0 && notices.length === 0 && !error)) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {error && (
        <div className="rounded bg-red-900/80 border border-red-700 p-2 text-sm text-red-100 shadow-lg">
          {error}
        </div>
      )}
      {notices.map((n) => (
        <div
          key={n.id}
          className="rounded-lg bg-slate-800 border border-slate-600 p-3 shadow-xl text-sm flex items-start gap-3"
        >
          <span className="flex-1">{n.text}</span>
          <button
            onClick={() => setNotices((prev) => prev.filter((x) => x.id !== n.id))}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
      {invites.map((inv) => (
        <div
          key={`${inv.kind}-${inv.id}`}
          className="rounded-lg bg-slate-800 border border-emerald-700 p-3 shadow-xl text-sm"
        >
          <div className="font-semibold text-emerald-300 mb-1">
            {inv.kind === 'game' ? 'Game invite' : 'Party invite'}
          </div>
          <div className="mb-3">
            <span className="font-medium">{inv.from_username ?? 'A friend'}</span>
            {inv.kind === 'game'
              ? ' wants to play Euchre with you.'
              : ' invited you to their party.'}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => accept(inv)}
              disabled={busyId === inv.id}
              className="flex-1 rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 disabled:opacity-50"
            >
              Accept
            </button>
            <button
              onClick={() => decline(inv)}
              disabled={busyId === inv.id}
              className="flex-1 rounded border border-slate-600 hover:bg-slate-700 px-3 py-1.5 disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function renderNotificationText(row: NotificationRow): string | null {
  const name =
    typeof row.payload === 'object' && row.payload !== null && 'from_username' in row.payload
      ? String((row.payload as { from_username?: unknown }).from_username ?? '')
      : '';
  const who = name || 'A friend';
  switch (row.kind) {
    case 'game_invite_declined':
      return `${who} declined your game invite.`;
    case 'party_invite_declined':
      return `${who} declined your party invite.`;
    default:
      return null;
  }
}
