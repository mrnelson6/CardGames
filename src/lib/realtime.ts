import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

let jwtBound = false;

export function bindRealtimeAuth() {
  if (jwtBound) return;
  jwtBound = true;
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }
    }
    if (event === 'SIGNED_OUT') {
      supabase.realtime.setAuth(null);
    }
  });
}

interface SubscribeOptions {
  channel: string;
  onSubscribed?: () => void;
  onError?: (err: unknown) => void;
  configure: (ch: RealtimeChannel) => RealtimeChannel;
}

export function subscribeWithReconnect(opts: SubscribeOptions): () => void {
  let attempt = 0;
  let cancelled = false;
  let current: RealtimeChannel | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (cancelled) return;
    const ch = opts.configure(supabase.channel(opts.channel));
    current = ch;
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        attempt = 0;
        opts.onSubscribed?.();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        opts.onError?.(err);
        if (cancelled) return;
        const delay = Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
        attempt += 1;
        retryTimer = setTimeout(() => {
          if (current) supabase.removeChannel(current).catch(() => {});
          connect();
        }, delay);
      }
    });
  };

  connect();

  return () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (current) supabase.removeChannel(current).catch(() => {});
  };
}
