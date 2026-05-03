// In-game chat for Euchre. Uses Supabase Realtime broadcast (no DB
// writes) since these messages are ephemeral — they auto-disappear
// after a few seconds and don't need history. Each game has its own
// channel `game-chat-${gameId}`. Players broadcast { seat, user_id,
// kind, content } and every other connected player receives it.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../../lib/supabase';

export type ChatKind = 'text' | 'emoji';

export interface ChatMessage {
  id: string;
  seat: number;
  user_id: string;
  kind: ChatKind;
  content: string;
  ts: number; // ms
}

const BUBBLE_TTL_MS = 4500;
const TICK_MS = 500;

export function useChat(
  gameId: string | null,
  mySeat: number | null,
  myUserId: string | null,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const subscribedRef = useRef(false);

  useEffect(() => {
    if (!gameId) return;
    const ch = supabase.channel(`game-chat-${gameId}`, {
      config: { broadcast: { self: true, ack: false } },
    });
    ch.on('broadcast', { event: 'chat' }, ({ payload }) => {
      const msg = payload as ChatMessage;
      setMessages((prev) => {
        // Cap to avoid unbounded growth in long sessions; only the last
        // few seconds matter for rendering anyway.
        const next = prev.length > 100 ? prev.slice(-50) : prev;
        return [...next, msg];
      });
    });
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') subscribedRef.current = true;
    });
    channelRef.current = ch;
    return () => {
      subscribedRef.current = false;
      supabase.removeChannel(ch).catch(() => {});
      channelRef.current = null;
    };
  }, [gameId]);

  // Tick to age out expired messages.
  useEffect(() => {
    if (messages.length === 0) return;
    const id = setInterval(() => {
      const cutoff = Date.now() - BUBBLE_TTL_MS;
      setMessages((prev) => {
        const next = prev.filter((m) => m.ts > cutoff);
        return next.length === prev.length ? prev : next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [messages.length]);

  const send = useCallback(
    (kind: ChatKind, content: string) => {
      if (!channelRef.current || !subscribedRef.current) return;
      if (mySeat === null || !myUserId) return;
      const msg: ChatMessage = {
        id:
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        seat: mySeat,
        user_id: myUserId,
        kind,
        content,
        ts: Date.now(),
      };
      void channelRef.current.send({
        type: 'broadcast',
        event: 'chat',
        payload: msg,
      });
    },
    [mySeat, myUserId],
  );

  // Latest unmuted message per seat (most recent within the TTL window).
  const latestBySeat = (mutes: Set<string>): Record<number, ChatMessage | null> => {
    const out: Record<number, ChatMessage | null> = { 0: null, 1: null, 2: null, 3: null };
    for (const m of messages) {
      if (mutes.has(m.user_id)) continue;
      const cur = out[m.seat];
      if (!cur || cur.ts < m.ts) out[m.seat] = m;
    }
    return out;
  };

  return { send, latestBySeat };
}

export const PHRASES: string[] = [
  'Hi!',
  'Nice play',
  'Good game',
  'GG',
  'Thanks',
  'Sorry',
  'My bad',
  'Hurry up',
  'Lol',
  'Wow',
  'Oof',
];

export const REACTIONS: string[] = [
  '\u{1F44D}', // thumbs up
  '❤️', // heart
  '\u{1F602}', // tears of joy
  '\u{1F525}', // fire
  '\u{1F389}', // party popper
  '\u{1F44F}', // clap
  '\u{1F622}', // crying
  '\u{1F634}', // sleeping
];
