// POST /functions/v1/create-euchre-room
// Body: {} (no fields). Caller (authenticated, including anon) becomes seat 0 of a new lobby.
// Returns: { game_id, invite_code, seat: 0 }

import {
  adminClient,
  authenticate,
  fail,
  generateInviteCode,
  json,
  preflight,
} from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const admin = adminClient();

  // Try up to 5 invite codes in the unlikely event of a collision.
  let attempt = 0;
  while (attempt < 5) {
    const code = generateInviteCode();
    const { data: game, error: gameErr } = await admin
      .from('games')
      .insert({
        game: 'euchre',
        status: 'lobby',
        team0_score: 0,
        team1_score: 0,
        invite_code: code,
        leader_id: user.id,
      })
      .select('id, invite_code')
      .single();

    if (gameErr) {
      if (gameErr.code === '23505') {
        attempt += 1;
        continue;
      }
      return fail(500, 'db_create_game', gameErr.message);
    }

    // Random initial dealer; will be re-set on game start anyway.
    const dealerSeat = Math.floor(Math.random() * 4);
    const { error: euErr } = await admin.from('euchre_games').insert({
      game_id: game.id,
      dealer_seat: dealerSeat,
      hand_number: 0,
    });
    if (euErr) {
      // Roll back games row.
      await admin.from('games').delete().eq('id', game.id);
      return fail(500, 'db_create_euchre', euErr.message);
    }

    const { error: pErr } = await admin.from('game_players').insert({
      game_id: game.id,
      seat: 0,
      user_id: user.id,
      is_bot: false,
      missed_turns: 0,
    });
    if (pErr) {
      await admin.from('games').delete().eq('id', game.id);
      return fail(500, 'db_seat_player', pErr.message);
    }

    await admin.from('game_actions').insert({
      game_id: game.id,
      seat: 0,
      action_type: 'create_room',
      payload: { invite_code: game.invite_code },
    });

    return json({ game_id: game.id, invite_code: game.invite_code, seat: 0 });
  }

  return fail(500, 'invite_code_collision', 'Could not generate unique invite code');
});
