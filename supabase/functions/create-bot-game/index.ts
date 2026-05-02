// POST /functions/v1/create-bot-game
// Body: {} (no fields).
// Creates an unranked game with the caller at seat 0 and bots at seats 1-3.
// Game starts immediately in the playing state — no lobby, no invite code.
// autoAdvanceBots fires once at the end so any seats that should act before
// the human (bidder = dealer+1) play their bot moves before we return.

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
} from '../_shared/http.ts';
import {
  buildDealForHand,
  type PlayerRow,
} from '../_shared/games/euchre/state.ts';
import { autoAdvanceBots } from '../_shared/games/euchre/auto_advance.ts';
import { type Seat } from '../_shared/games/euchre/euchre.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const admin = adminClient();

  const { data: gRow, error: gErr } = await admin
    .from('games')
    .insert({
      game: 'euchre',
      status: 'playing',
      team0_score: 0,
      team1_score: 0,
      // mode null + invite_code null => unranked, single-session
    })
    .select('id')
    .single();
  if (gErr) return fail(500, 'db_create_game', gErr.message);
  const gameId = gRow.id;

  const dealerSeat = Math.floor(Math.random() * 4);

  const { error: euErr } = await admin.from('euchre_games').insert({
    game_id: gameId,
    dealer_seat: dealerSeat,
    hand_number: 0,
  });
  if (euErr) {
    await admin.from('games').delete().eq('id', gameId);
    return fail(500, 'db_create_euchre', euErr.message);
  }

  const players: PlayerRow[] = [
    { game_id: gameId, seat: 0, user_id: user.id, is_bot: false, missed_turns: 0 },
    { game_id: gameId, seat: 1, user_id: null,    is_bot: true,  missed_turns: 0 },
    { game_id: gameId, seat: 2, user_id: null,    is_bot: true,  missed_turns: 0 },
    { game_id: gameId, seat: 3, user_id: null,    is_bot: true,  missed_turns: 0 },
  ];
  const { error: pErr } = await admin.from('game_players').insert(players);
  if (pErr) {
    await admin.from('games').delete().eq('id', gameId);
    return fail(500, 'db_seat_players', pErr.message);
  }

  const deal = buildDealForHand(gameId, players, dealerSeat as Seat, 1);
  const { error: hErr } = await admin.from('game_hands').upsert(deal.hands);
  if (hErr) return fail(500, 'db_deal_hands', hErr.message);

  const { error: euUpdErr } = await admin
    .from('euchre_games')
    .update({
      hand_number: 1,
      upcard: deal.euchre.upcard,
      upcard_status: deal.euchre.upcard_status,
    })
    .eq('game_id', gameId);
  if (euUpdErr) return fail(500, 'db_eu_update', euUpdErr.message);

  const { error: gUpdErr } = await admin
    .from('games')
    .update({
      current_seat: deal.current_seat,
      turn_deadline: deal.turn_deadline,
    })
    .eq('id', gameId);
  if (gUpdErr) return fail(500, 'db_game_update', gUpdErr.message);

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: dealerSeat,
    action_type: 'create_bot_game',
    payload: { dealer_seat: dealerSeat },
  });

  await autoAdvanceBots(admin, gameId);

  return json({ game_id: gameId });
});
