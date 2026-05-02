// POST /functions/v1/enforce-timeout-sweep
// Called by pg_cron every ~10s. Scans games whose turn_deadline expired
// more than 5 seconds ago (giving connected clients first crack at firing
// enforce-timeout themselves) and plays a bot move on each abandoned table.
// Auth: requires service_role bearer (or local-stack secret).

import { adminClient, fail, json, preflight } from '../_shared/http.ts';
import {
  loadEuchreState,
  loadGame,
  loadPlayers,
} from '../_shared/games/euchre/state.ts';
import { executeBotMove } from '../_shared/games/euchre/bot_action.ts';
import { autoAdvanceBots } from '../_shared/games/euchre/auto_advance.ts';
import type { Seat } from '../_shared/games/euchre/euchre.ts';

const SWEEP_BUFFER_SECONDS = 5;
const MAX_GAMES_PER_TICK = 50;
const MISS_LIMIT = 2;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const auth = req.headers.get('Authorization') ?? '';
  const expectedKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!auth.endsWith(expectedKey) || expectedKey.length === 0) {
    return fail(401, 'no_auth', 'Service-role bearer required');
  }

  const admin = adminClient();
  const cutoff = new Date(Date.now() - SWEEP_BUFFER_SECONDS * 1000).toISOString();

  const { data: stale, error: sErr } = await admin
    .from('games')
    .select('id, current_seat, turn_deadline')
    .eq('status', 'playing')
    .lt('turn_deadline', cutoff)
    .order('turn_deadline')
    .limit(MAX_GAMES_PER_TICK);
  if (sErr) return fail(500, 'db_scan', sErr.message);

  const acted: string[] = [];
  const skipped: Array<{ game_id: string; reason: string }> = [];

  for (const row of stale ?? []) {
    const result = await sweepOne(admin, row.id);
    if (result.acted) acted.push(row.id);
    else skipped.push({ game_id: row.id, reason: result.reason });
  }

  return json({ ok: true, acted: acted.length, skipped: skipped.length, details: { acted, skipped } });
});

async function sweepOne(
  admin: ReturnType<typeof adminClient>,
  gameId: string,
): Promise<{ acted: boolean; reason: string }> {
  const game = await loadGame(admin, gameId);
  if (!game) return { acted: false, reason: 'no_game' };
  if (game.status !== 'playing') return { acted: false, reason: 'not_playing' };
  if (game.current_seat === null) return { acted: false, reason: 'no_current_seat' };
  if (!game.turn_deadline) return { acted: false, reason: 'no_deadline' };
  if (Date.parse(game.turn_deadline) > Date.now() - SWEEP_BUFFER_SECONDS * 1000) {
    return { acted: false, reason: 'within_buffer' };
  }

  const players = await loadPlayers(admin, gameId);
  const me = players.find((p) => p.seat === game.current_seat);
  if (!me) return { acted: false, reason: 'no_player' };

  const newMisses = me.missed_turns + 1;
  const willBot = newMisses >= MISS_LIMIT || me.is_bot;
  const upd = await admin
    .from('game_players')
    .update({ missed_turns: newMisses, is_bot: willBot })
    .eq('game_id', gameId)
    .eq('seat', game.current_seat);
  if (upd.error) return { acted: false, reason: `db: ${upd.error.message}` };

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: game.current_seat,
    action_type: 'timeout_sweep',
    payload: { missed_turns: newMisses, became_bot: willBot && !me.is_bot },
  });

  const eu = await loadEuchreState(admin, gameId);
  if (!eu) return { acted: false, reason: 'no_euchre_state' };

  const result = await executeBotMove(admin, game, eu, players, game.current_seat as Seat);
  if ('error' in result) return { acted: false, reason: `bot: ${result.error}` };

  await autoAdvanceBots(admin, gameId);
  return { acted: true, reason: 'ok' };
}
