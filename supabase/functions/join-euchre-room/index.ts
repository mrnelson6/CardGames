// POST /functions/v1/join-euchre-room
// Body: { invite_code: string, seat?: 0|1|2|3 }
// Seats the caller; if all 4 are filled, atomically transitions to 'playing' and deals hand 1.
// Returns: { game_id, invite_code, seat, status }

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';
import {
  buildDealForHand,
  loadEuchreState,
  loadGame,
  loadPlayers,
} from '../_shared/games/euchre/state.ts';
import type { Seat } from '../_shared/games/euchre/euchre.ts';

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

  // Re-count and try to transition if we filled the last seat.
  const seatedCount = players.length + 1;
  if (seatedCount < 4) {
    return json({
      game_id: game.id,
      invite_code: game.invite_code,
      seat: chosen,
      status: 'lobby',
    });
  }

  // Attempt atomic lobby→playing transition. Only one concurrent joiner wins.
  const { data: started, error: tErr } = await admin
    .from('games')
    .update({ status: 'playing' })
    .eq('id', game.id)
    .eq('status', 'lobby')
    .select('id')
    .maybeSingle();
  if (tErr) return fail(500, 'db_start', tErr.message);

  if (started) {
    // We won the race — deal hand 1.
    const seated = await loadPlayers(admin, game.id);
    const euState = await loadEuchreState(admin, game.id);
    if (!euState) return fail(500, 'no_euchre_state', 'euchre_games row missing');

    // Dealer rotation start: keep the dealer chosen at room creation.
    const deal = buildDealForHand(game.id, seated, euState.dealer_seat as Seat, 1);

    const { error: hErr } = await admin.from('game_hands').upsert(deal.hands);
    if (hErr) return fail(500, 'db_deal_hands', hErr.message);

    const { error: euErr } = await admin
      .from('euchre_games')
      .update({
        hand_number: 1,
        upcard: deal.euchre.upcard,
        upcard_status: deal.euchre.upcard_status,
        trump_suit: null,
        maker_seat: null,
        alone_seat: null,
        current_trick_id: null,
      })
      .eq('game_id', game.id);
    if (euErr) return fail(500, 'db_euchre_update', euErr.message);

    const { error: gUErr } = await admin
      .from('games')
      .update({
        current_seat: deal.current_seat,
        turn_deadline: deal.turn_deadline,
      })
      .eq('id', game.id);
    if (gUErr) return fail(500, 'db_game_update', gUErr.message);

    await admin.from('game_actions').insert({
      game_id: game.id,
      seat: euState.dealer_seat,
      action_type: 'deal_hand',
      payload: { hand_number: 1, dealer_seat: euState.dealer_seat },
    });
  }

  // Fetch authoritative status (whether we won the race or not).
  const fresh = await loadGame(admin, game.id);
  return json({
    game_id: game.id,
    invite_code: game.invite_code,
    seat: chosen,
    status: fresh?.status ?? 'lobby',
  });
});
