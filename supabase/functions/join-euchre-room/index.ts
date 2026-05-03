// POST /functions/v1/join-euchre-room
// Body: { invite_code: string, seat?: 0|1|2|3 }
// Seats the caller in a private-room lobby. Does NOT start the game —
// the room leader does that explicitly via euchre-room-action.
// Returns: { game_id, invite_code, seat, status }

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';
import { loadGame, loadPlayers } from '../_shared/games/euchre/state.ts';

interface Body {
  invite_code: string;
  seat?: number;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.invite_code) return fail(400, 'bad_body', 'invite_code required');
  if (body.seat !== undefined && (body.seat < 0 || body.seat > 3 || !Number.isInteger(body.seat))) {
    return fail(400, 'bad_body', 'seat must be 0-3');
  }

  const admin = adminClient();

  const { data: game, error: gErr } = await admin
    .from('games')
    .select('id, invite_code, status, game')
    .eq('invite_code', body.invite_code.toUpperCase())
    .eq('game', 'euchre')
    .maybeSingle();
  if (gErr) return fail(500, 'db_lookup', gErr.message);
  if (!game) return fail(404, 'no_room', 'No room with that code');
  if (game.status === 'finished' || game.status === 'abandoned') {
    return fail(409, 'closed_room', `Room is ${game.status}`);
  }

  const players = await loadPlayers(admin, game.id);
  const existing = players.find((p) => p.user_id === user.id);
  if (existing) {
    return json({
      game_id: game.id,
      invite_code: game.invite_code,
      seat: existing.seat,
      status: game.status,
    });
  }

  if (game.status !== 'lobby') {
    return fail(409, 'in_progress', 'Room already started');
  }

  const taken = new Set(players.map((p) => p.seat));
  let chosen: number | null = null;
  if (body.seat !== undefined) {
    if (taken.has(body.seat)) return fail(409, 'seat_taken', 'Seat is taken');
    chosen = body.seat;
  } else {
    for (let s = 0; s < 4; s++) {
      if (!taken.has(s)) { chosen = s; break; }
    }
  }
  if (chosen === null) return fail(409, 'room_full', 'All four seats are taken');

  const { error: insertErr } = await admin.from('game_players').insert({
    game_id: game.id,
    seat: chosen,
    user_id: user.id,
    is_bot: false,
    missed_turns: 0,
  });
  if (insertErr) {
    if (insertErr.code === '23505') {
      return fail(409, 'seat_taken', 'Seat just got taken');
    }
    return fail(500, 'db_seat', insertErr.message);
  }

  await admin.from('game_actions').insert({
    game_id: game.id,
    seat: chosen,
    action_type: 'join_room',
    payload: { user_id: user.id },
  });

  const fresh = await loadGame(admin, game.id);
  return json({
    game_id: game.id,
    invite_code: game.invite_code,
    seat: chosen,
    status: fresh?.status ?? 'lobby',
  });
});
