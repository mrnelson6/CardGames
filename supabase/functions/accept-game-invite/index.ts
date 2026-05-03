// POST /functions/v1/accept-game-invite
// Body: { invite_id }
// Caller (must be the invite's to_user) joins the game and the invite row
// is deleted. Returns the same shape as join-euchre-room so the client
// can navigate consistently.

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
import { autoAdvanceBots } from '../_shared/games/euchre/auto_advance.ts';
import type { Seat } from '../_shared/games/euchre/euchre.ts';

interface Body { invite_id: string }

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.invite_id) return fail(400, 'bad_body', 'invite_id required');

  const admin = adminClient();

  const { data: invite, error: iErr } = await admin
    .from('game_invites')
    .select('id, from_user, to_user, game_id, invite_code')
    .eq('id', body.invite_id)
    .maybeSingle();
  if (iErr) return fail(500, 'db_lookup', iErr.message);
  if (!invite) return fail(404, 'no_invite', 'Invite not found');
  if (invite.to_user !== user.id) return fail(403, 'not_yours', 'Invite is not for you');

  const game = await loadGame(admin, invite.game_id);
  if (!game) {
    await admin.from('game_invites').delete().eq('id', invite.id);
    return fail(410, 'game_gone', 'The invited game no longer exists');
  }
  if (game.status === 'finished' || game.status === 'abandoned') {
    await admin.from('game_invites').delete().eq('id', invite.id);
    return fail(409, 'closed_room', `Room is ${game.status}`);
  }

  const players = await loadPlayers(admin, invite.game_id);
  const existing = players.find((p) => p.user_id === user.id);
  if (!existing) {
    if (game.status !== 'lobby') {
      return fail(409, 'in_progress', 'Room already started');
    }
    const taken = new Set(players.map((p) => p.seat));
    let chosen: number | null = null;
    for (let s = 0; s < 4; s++) {
      if (!taken.has(s)) { chosen = s; break; }
    }
    if (chosen === null) return fail(409, 'room_full', 'All four seats are taken');

    const insErr = await admin.from('game_players').insert({
      game_id: invite.game_id,
      seat: chosen,
      user_id: user.id,
      is_bot: false,
      missed_turns: 0,
    });
    if (insErr.error) {
      if (insErr.error.code === '23505') {
        return fail(409, 'seat_taken', 'Seat just got taken');
      }
      return fail(500, 'db_seat', insErr.error.message);
    }

    await admin.from('game_actions').insert({
      game_id: invite.game_id,
      seat: chosen,
      action_type: 'accept_invite',
      payload: { from_invite: invite.id },
    });

    // 4th player triggers the same start-game logic as join-euchre-room.
    if (players.length + 1 >= 4) {
      const { data: started } = await admin
        .from('games')
        .update({ status: 'playing' })
        .eq('id', invite.game_id)
        .eq('status', 'lobby')
        .select('id')
        .maybeSingle();
      if (started) {
        const seated = await loadPlayers(admin, invite.game_id);
        const euState = await loadEuchreState(admin, invite.game_id);
        if (euState) {
          const deal = buildDealForHand(invite.game_id, seated, euState.dealer_seat as Seat, 1);
          await admin.from('game_hands').upsert(deal.hands);
          await admin.from('euchre_games').update({
            hand_number: 1,
            upcard: deal.euchre.upcard,
            upcard_status: deal.euchre.upcard_status,
            trump_suit: null,
            maker_seat: null,
            alone_seat: null,
            current_trick_id: null,
          }).eq('game_id', invite.game_id);
          await admin.from('games').update({
            current_seat: deal.current_seat,
            turn_deadline: deal.turn_deadline,
          }).eq('id', invite.game_id);
          await admin.from('game_actions').insert({
            game_id: invite.game_id,
            seat: euState.dealer_seat,
            action_type: 'deal_hand',
            payload: { hand_number: 1, dealer_seat: euState.dealer_seat },
          });
          await autoAdvanceBots(admin, invite.game_id);
        }
      }
    }
  }

  // Consume the invite.
  await admin.from('game_invites').delete().eq('id', invite.id);

  const fresh = await loadGame(admin, invite.game_id);
  return json({
    game_id: invite.game_id,
    invite_code: invite.invite_code,
    seat: existing?.seat ?? players.find((p) => p.user_id === user.id)?.seat ?? null,
    status: fresh?.status ?? 'lobby',
  });
});
