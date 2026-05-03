// App-level toast that listens for incoming game_invites for the signed-in
// user and offers Accept / Decline. Mounted in App.tsx so it works on every
// authenticated page.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { subscribeWithReconnect } from '../lib/realtime';
import { useAuth } from '../lib/auth';
import { euchreApi } from '../games/euchre/api';
import type { GameInviteRow, ProfileRow } from '../lib/database.types';

interface InviteWithName extends GameInviteRow {
  from_username: string | null;
}

export function InviteNotifier() {
  const { session } = useAuth();
  const me = session?.user.id ?? null;
  const navigate = useNavigate();
  const [invites, setInvites] = useState<InviteWithName[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) { setInvites([]); return; }

    const decorate = async (rows: GameInviteRow[]): Promise<InviteWithName[]> => {
      if (rows.length === 0) return [];
      const ids = Array.from(new Set(rows.map((r) => r.from_user)));
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, username')
        .in('user_id', ids);
      const nameByUser = new Map<string, string>();
      for (const p of (profiles ?? []) as Pick<ProfileRow, 'user_id' | 'username'>[]) {
        nameByUser.set(p.user_id, p.username);
      }
      return rows.map((r) => ({ ...r, from_username: nameByUser.get(r.from_user) ?? null }));
    };

    const refresh = async () => {
      const { data } = await supabase
        .from('game_invites')
        .select('*')
        .eq('to_user', me)
        .order('created_at', { ascending: false });
      const decorated = await decorate((data ?? []) as GameInviteRow[]);
      setInvites(decorated);
    };
    refresh();

    const unsub = subscribeWithReconnect({
      channel: `game-invites-${me}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'game_invites', filter: `to_user=eq.${me}` },
          refresh,
        ),
    });
    return () => { unsub(); };
  }, [me]);

  const accept = async (inv: InviteWithName) => {
    setBusyId(inv.id);
    setError(null);
    try {
      const r = await euchreApi.acceptGameInvite(inv.id);
      if (r.status === 'playing') {
        navigate(`/games/euchre/g/${r.game_id}`);
      } else {
        navigate(`/games/euchre/room/${r.invite_code}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const decline = async (inv: InviteWithName) => {
    setBusyId(inv.id);
    setError(null);
    try {
      const { error: dErr } = await supabase
        .from('game_invites')
        .delete()
        .eq('id', inv.id);
      if (dErr) throw new Error(dErr.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (!me || invites.length === 0) {
    if (!error) return null;
  }

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {error && (
        <div className="rounded bg-red-900/80 border border-red-700 p-2 text-sm text-red-100 shadow-lg">
          {error}
        </div>
      )}
      {invites.map((inv) => (
        <div
          key={inv.id}
          className="rounded-lg bg-slate-800 border border-emerald-700 p-3 shadow-xl text-sm animate-in slide-in-from-right"
        >
          <div className="font-semibold text-emerald-300 mb-1">Game invite</div>
          <div className="mb-3">
            <span className="font-medium">{inv.from_username ?? 'A friend'}</span>
            {' '}wants to play Euchre with you.
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
