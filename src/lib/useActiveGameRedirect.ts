// App-level: when a game_players row appears for the signed-in user
// (because someone matchmade them, or a party leader started a bot
// game etc.), pull them into the game page automatically — but only
// if they're not already on it. Mirrors the pattern that lives in
// Queue.tsx but is global so the partner doesn't have to be on the
// queue page to get redirected.

import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from './supabase';
import { subscribeWithReconnect } from './realtime';

export function useActiveGameRedirect(userId: string | null) {
  const navigate = useNavigate();
  const location = useLocation();
  const handledRef = useRef<Set<string>>(new Set());
  // Hold a fresh reference to the current pathname so the realtime
  // callback always sees where the user is right now.
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  useEffect(() => {
    if (!userId) return;

    const tryRedirect = async (gameId: string) => {
      if (handledRef.current.has(gameId)) return;
      // Don't redirect if we're already on the game page (refresh, etc).
      if (pathnameRef.current.startsWith(`/games/euchre/g/${gameId}`)) return;
      // Confirm the game is actually playing — game_players inserts can
      // happen for lobby rooms too, and we don't want to yank the user
      // out of the room into a not-yet-started game.
      const { data: game } = await supabase
        .from('games')
        .select('status')
        .eq('id', gameId)
        .maybeSingle();
      if (!game || (game as { status?: string }).status !== 'playing') return;
      handledRef.current.add(gameId);
      navigate(`/games/euchre/g/${gameId}`);
    };

    const unsub = subscribeWithReconnect({
      channel: `active-game-${userId}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'game_players',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            const row = payload.new as { game_id?: string };
            if (row.game_id) void tryRedirect(row.game_id);
          },
        ),
    });
    return () => unsub();
  }, [userId, navigate]);
}
