// POST /functions/v1/invite-friend-to-game
// Body: { to_user: uuid }
// Creates a private Euchre room and a game_invites row pointing at it.
// The friend's client receives a Realtime INSERT on game_invites and shows
// an accept/decline toast. The caller is taken to the room lobby to wait.
// Returns: { game_id, invite_code, invite_id }

import {
  adminClient,
  authenticate,
  fail,
  generateInviteCode,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';

interface Body { to_user: string }

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;
  if (user.isAnonymous) {
    return fail(403, 'anon_blocked', 'Sign in with email to invite friends');
  }

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.to_user) return fail(400, 'bad_body', 'to_user required');
  if (body.to_user === user.id) return fail(400, 'self_invite', "Can't invite yourself");

  const admin = adminClient();

  // Friendship check.
  const lo = user.id < body.to_user ? user.id : body.to_user;
  const hi = user.id < body.to_user ? body.to_user : user.id;
  const { data: friendship } = await admin
    .from('friendships')
    .select('user_a')
    .eq('user_a', lo)
    .eq('user_b', hi)
    .maybeSingle();
  if (!friendship) return fail(403, 'not_friends', 'You can only invite friends');

  // Create the room. Same shape as create-euchre-room.
  let attempt = 0;
  let game: { id: string; invite_code: string } | null = null;
  while (attempt < 5 && !game) {
    const code = generateInviteCode();
    const { data, error } = await admin
      .from('games')
      .insert({ game: 'euchre', status: 'lobby', team0_score: 0, team1_score: 0, invite_code: code })
      .select('id, invite_code')
      .single();
    if (!error && data) { game = data; break; }
    if (error?.code === '23505') { attempt += 1; continue; }
    return fail(500, 'db_create_game', error?.message ?? 'unknown');
  }
  if (!game) return fail(500, 'invite_code_collision', 'Could not generate unique invite code');

  const dealerSeat = Math.floor(Math.random() * 4);
  const euErr = await admin.from('euchre_games').insert({
    game_id: game.id,
    dealer_seat: dealerSeat,
    hand_number: 0,
  });
  if (euErr.error) {
    await admin.from('games').delete().eq('id', game.id);
    return fail(500, 'db_create_euchre', euErr.error.message);
  }

  const seatErr = await admin.from('game_players').insert({
    game_id: game.id,
    seat: 0,
    user_id: user.id,
    is_bot: false,
    missed_turns: 0,
  });
  if (seatErr.error) {
    await admin.from('games').delete().eq('id', game.id);
    return fail(500, 'db_seat_player', seatErr.error.message);
  }

  // Insert the invite row. Unique-violation here means there's already an
  // outstanding invite from this user to this friend for this game — fine,
  // shouldn't happen at this point but treat as success.
  const { data: invite, error: invErr } = await admin
    .from('game_invites')
    .insert({
      from_user: user.id,
      to_user: body.to_user,
      game_id: game.id,
      invite_code: game.invite_code,
    })
    .select('id')
    .single();
  if (invErr) return fail(500, 'db_invite', invErr.message);

  await admin.from('game_actions').insert({
    game_id: game.id,
    seat: 0,
    action_type: 'invite_friend',
    payload: { to_user: body.to_user, invite_id: invite.id },
  });

  return json({
    game_id: game.id,
    invite_code: game.invite_code,
    invite_id: invite.id,
  });
});
