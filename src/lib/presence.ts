// Global "who's online" tracker built on Supabase Realtime presence.
//
// One module-level channel ('online-users') tracks every authenticated user.
// usePresenceTracker() runs once at the app shell to track self; usePresence()
// subscribes a component to the live online-set. Both are cheap to call from
// multiple places — they share the same singleton subscription.

import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

const CHANNEL = 'online-users';

let channel: RealtimeChannel | null = null;
let trackedUserId: string | null = null;
let onlineUsers: Set<string> = new Set();
const listeners = new Set<(s: Set<string>) => void>();

function notify() {
  for (const fn of listeners) fn(onlineUsers);
}

function ensureChannel() {
  if (channel) return channel;
  const ch = supabase.channel(CHANNEL, { config: { presence: { key: '' } } });
  ch.on('presence', { event: 'sync' }, () => {
    const state = ch.presenceState();
    onlineUsers = new Set(Object.keys(state));
    notify();
  });
  ch.subscribe(async (status) => {
    if (status === 'SUBSCRIBED' && trackedUserId) {
      await ch.track({ user_id: trackedUserId, online_at: new Date().toISOString() });
    }
  });
  channel = ch;
  return ch;
}

export function startPresenceFor(userId: string) {
  if (trackedUserId === userId && channel) return;
  if (trackedUserId && trackedUserId !== userId && channel) {
    // user identity changed (sign-out → different sign-in). Tear down.
    supabase.removeChannel(channel).catch(() => {});
    channel = null;
  }
  trackedUserId = userId;
  const ch = ensureChannel();
  // If channel was already SUBSCRIBED before this call, kick off track now.
  void ch.track({ user_id: userId, online_at: new Date().toISOString() }).catch(() => {});
}

export function stopPresence() {
  if (!channel) {
    trackedUserId = null;
    return;
  }
  channel.untrack().catch(() => {});
  supabase.removeChannel(channel).catch(() => {});
  channel = null;
  trackedUserId = null;
  onlineUsers = new Set();
  notify();
}

/** Track the current user's online status. Mount once at the app root. */
export function usePresenceTracker(userId: string | null) {
  useEffect(() => {
    if (!userId) {
      stopPresence();
      return;
    }
    startPresenceFor(userId);
    // No teardown on unmount — we want presence to persist across page nav.
    // It's torn down on sign-out via the !userId branch above.
  }, [userId]);
}

/** Subscribe a component to the live online-user set. */
export function usePresence(): Set<string> {
  const [users, setUsers] = useState<Set<string>>(onlineUsers);
  useEffect(() => {
    ensureChannel();
    listeners.add(setUsers);
    setUsers(onlineUsers);
    return () => { listeners.delete(setUsers); };
  }, []);
  return users;
}
