// POST /functions/v1/euchre-discard
// Body: { game_id, card }
// Dealer-only after order_up. Removes card from dealer's hand, stores it as discarded_card (private).
// Transitions to play phase: clears upcard, sets current_seat = first player after dealer (skipping alone partner).

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';
import {
  type Card,
  type Seat,
  nextSeat,
} from '../_shared/games/euchre/euchre.ts';
import {
  TURN_SECONDS,
  deadlineNowPlus,
  loadEuchreState,
  loadGame,
  loadPlayers,
} from '../_shared/games/euchre/state.ts';
import { autoAdvanceBots } from '../_shared/games/euchre/auto_advance.ts';

interface Body {
  game_id: string;
  card: Card;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.game_id || !body.card) return fail(400, 'bad_body', 'game_id and card required');

  const admin = adminClient();
  const game = await loadGame(admin, body.game_id);
  if (!game) return fail(404, 'no_game', 'Game not found');
  if (game.status !== 'playing') return fail(409, 'not_playing', `status=${game.status}`);

  const eu = await loadEuchreState(admin, body.game_id);
  if (!eu) return fail(500, 'no_euchre_state', 'euchre_games row missing');
  if (eu.upcard_status !== 'taken' || eu.trump_suit === null) {
    return fail(409, 'not_discarding', 'Not in discard phase');
  }
  const dealer = eu.dealer_seat as Seat;

  const players = await loadPlayers(admin, body.game_id);
  const me = players.find((p) => p.user_id === user.id);
  if (!me) return fail(403, 'not_seated', 'You are not at this table');
  if (me.seat !== dealer) return fail(409, 'not_dealer', 'Only the dealer discards');
  if (game.current_seat !== dealer) return fail(409, 'not_your_turn', 'Not your turn');

  const { data: hand, error: hErr } = await admin
    .from('game_hands')
    .select('cards')
    .eq('game_id', body.game_id)
    .eq('seat', dealer)
    .single();
  if (hErr) return fail(500, 'db_hand_load', hErr.message);

  const cards = hand.cards as Card[];
  const idx = cards.indexOf(body.card);
  if (idx === -1) return fail(400, 'bad_card', 'Card not in hand');
  const newCards = cards.slice(0, idx).concat(cards.slice(idx + 1));
  if (newCards.length !== 5) {
    return fail(500, 'hand_size', `Expected 5 after discard, got ${newCards.length}`);
  }

  const { error: uErr } = await admin
    .from('game_hands')
    .update({ cards: newCards, discarded_card: body.card })
    .eq('game_id', body.game_id)
    .eq('seat', dealer);
  if (uErr) return fail(500, 'db_hand_update', uErr.message);

  const first = nextSeat(dealer, eu.alone_seat as Seat | null);

  const { error: euErr } = await admin
    .from('euchre_games')
    .update({ upcard: null })
    .eq('game_id', body.game_id);
  if (euErr) return fail(500, 'db_eu_update', euErr.message);

  const { error: gErr } = await admin
    .from('games')
    .update({ current_seat: first, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
    .eq('id', body.game_id);
  if (gErr) return fail(500, 'db_game_update', gErr.message);

  await admin.from('game_actions').insert({
    game_id: body.game_id,
    seat: dealer,
    action_type: 'discard',
    payload: {},
  });

  await autoAdvanceBots(admin, body.game_id);
  return json({ ok: true, phase: 'play', current_seat: first });
});
