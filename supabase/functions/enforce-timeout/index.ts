// POST /functions/v1/enforce-timeout
// Body: { game_id, expected_seat, expected_deadline }
// Idempotent: if state has moved off (current_seat or turn_deadline differs),
// or the deadline hasn't actually passed, returns ok with acted=false. Otherwise
// increments missed_turns, sets is_bot at >=2, and plays one bot move on behalf
// of the timed-out seat. Then auto-advances through any remaining bot seats.

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';
import { type Seat } from '../_shared/games/euchre/euchre.ts';
import {
  loadEuchreState,
  loadGame,
  loadPlayers,
} from '../_shared/games/euchre/state.ts';
import { executeBotMove } from '../_shared/games/euchre/bot_action.ts';
import { autoAdvanceBots } from '../_shared/games/euchre/auto_advance.ts';

interface Body {
  game_id: string;
  expected_seat: number;
  expected_deadline: string;
}

const MISS_LIMIT = 2;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  // Anyone authenticated may fire this — the equality checks gate it.
  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.game_id || body.expected_seat === undefined || !body.expected_deadline) {
    return fail(400, 'bad_body', 'game_id, expected_seat, expected_deadline required');
  }

  const admin = adminClient();
  const game = await loadGame(admin, body.game_id);
  if (!game) return fail(404, 'no_game', 'Game not found');
  if (game.status !== 'playing') return json({ ok: true, acted: false, reason: 'not_playing' });
  if (game.current_seat !== body.expected_seat) {
    return json({ ok: true, acted: false, reason: 'seat_moved' });
  }
  // Compare deadlines as numeric times (ms) — string equality fails because
  // Postgres returns microseconds while Date.toISOString() emits milliseconds.
  const dbDeadlineMs = Date.parse(game.turn_deadline);
  const expectedMs = Date.parse(body.expected_deadline);
  if (Math.abs(dbDeadlineMs - expectedMs) > 1) {
    return json({ ok: true, acted: false, reason: 'deadline_moved' });
  }
  if (dbDeadlineMs > Date.now()) {
    return json({ ok: true, acted: false, reason: 'not_yet_expired' });
  }

  const players = await loadPlayers(admin, body.game_id);
  const me = players.find((p) => p.seat === body.expected_seat);
  if (!me) return fail(500, 'no_player', `seat ${body.expected_seat} unfilled`);

  // Increment missed_turns; flip is_bot if we hit the limit.
  const newMisses = me.missed_turns + 1;
  const willBot = newMisses >= MISS_LIMIT || me.is_bot;
  const update = await admin
    .from('game_players')
    .update({ missed_turns: newMisses, is_bot: willBot })
    .eq('game_id', body.game_id)
    .eq('seat', body.expected_seat);
  if (update.error) return fail(500, 'db_player_update', update.error.message);

  await admin.from('game_actions').insert({
    game_id: body.game_id,
    seat: body.expected_seat,
    action_type: 'timeout',
    payload: { missed_turns: newMisses, became_bot: willBot && !me.is_bot },
  });

  const eu = await loadEuchreState(admin, body.game_id);
  if (!eu) return fail(500, 'no_euchre_state', 'euchre_games row missing');

  const result = await executeBotMove(admin, game, eu, players, body.expected_seat as Seat);
  if ('error' in result) {
    return fail(500, 'bot_move_failed', result.error);
  }

  await autoAdvanceBots(admin, body.game_id);

  return json({
    ok: true,
    acted: true,
    seat: body.expected_seat,
    missed_turns: newMisses,
    became_bot: willBot && !me.is_bot,
    phase: result.phase,
  });
});
