// After any state-advancing move, loop while current_seat is is_bot and play
// bot moves until we land on a human seat or the game ends. Caps at 25 moves
// per call to avoid runaway loops on bugs.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { type Seat } from './euchre.ts';
import { executeBotMove } from './bot_action.ts';
import { loadEuchreState, loadGame, loadPlayers } from './state.ts';

const MAX_BOT_STEPS = 25;
// Randomized pause before each bot move. Long enough to feel like the bot is
// "thinking" but short enough that 3 consecutive bots don't drag forever.
// The HTTP call blocks for the duration; Realtime delivers each move to the
// client as it commits so the human's UI animates naturally.
const BOT_DELAY_MIN_MS = 700;
const BOT_DELAY_MAX_MS = 1200;

export async function autoAdvanceBots(
  admin: SupabaseClient,
  gameId: string,
): Promise<void> {
  for (let i = 0; i < MAX_BOT_STEPS; i++) {
    const game = await loadGame(admin, gameId);
    if (!game || game.status !== 'playing' || game.current_seat === null) return;

    const players = await loadPlayers(admin, gameId);
    const me = players.find((p) => p.seat === game.current_seat);
    if (!me || !me.is_bot) return;

    const eu = await loadEuchreState(admin, gameId);
    if (!eu) return;

    const delay = BOT_DELAY_MIN_MS + Math.random() * (BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS);
    await new Promise((resolve) => setTimeout(resolve, delay));

    const result = await executeBotMove(admin, game, eu, players, game.current_seat as Seat);
    if ('error' in result) {
      console.error(`autoAdvanceBots step ${i}: ${result.error}`);
      return;
    }
  }
  console.warn(`autoAdvanceBots: hit MAX_BOT_STEPS=${MAX_BOT_STEPS} for game ${gameId}`);
}
