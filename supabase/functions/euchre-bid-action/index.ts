// POST /functions/v1/euchre-bid-action
// Body: { game_id, action: 'pass' | 'order_up' | 'call_trump', suit?: Suit, alone?: boolean }
// Validates that caller is the current bidder; mutates trump_suit / upcard_status etc.

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
  type Suit,
  nextSeat,
  suitOf,
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
  action: 'pass' | 'order_up' | 'call_trump';
  suit?: Suit;
  alone?: boolean;
}

const VALID_SUITS: Suit[] = ['C', 'D', 'H', 'S'];

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.game_id) return fail(400, 'bad_body', 'game_id required');
  if (!['pass', 'order_up', 'call_trump'].includes(body.action)) {
    return fail(400, 'bad_action', 'unknown action');
  }

  const admin = adminClient();
  const game = await loadGame(admin, body.game_id);
  if (!game) return fail(404, 'no_game', 'Game not found');
  if (game.status !== 'playing') return fail(409, 'not_playing', `status=${game.status}`);

  const eu = await loadEuchreState(admin, body.game_id);
  if (!eu) return fail(500, 'no_euchre_state', 'euchre_games row missing');
  if (eu.trump_suit !== null) return fail(409, 'not_bidding', 'Bidding is over');
  if (!eu.upcard) return fail(500, 'no_upcard', 'No upcard set');

  const players = await loadPlayers(admin, body.game_id);
  const me = players.find((p) => p.user_id === user.id);
  if (!me) return fail(403, 'not_seated', 'You are not at this table');
  if (game.current_seat !== me.seat) return fail(409, 'not_your_turn', 'Not your turn');

  const seat = me.seat as Seat;
  const dealer = eu.dealer_seat as Seat;
  const round: 1 | 2 = eu.upcard_status === 'face_up' ? 1 : 2;
  const upcardSuit = suitOf(eu.upcard) as Suit;

  if (body.action === 'pass') {
    if (round === 2 && seat === dealer) {
      return fail(409, 'stick_the_dealer', 'Dealer cannot pass in round 2');
    }
    return await handleBidProgression(admin, game.id, eu, seat, dealer, round);
  }

  if (body.action === 'order_up') {
    if (round !== 1) return fail(409, 'wrong_round', 'order_up only in round 1');
    return await acceptBid(admin, game.id, eu, {
      maker: seat,
      alone: body.alone === true ? seat : null,
      trump: upcardSuit,
      goingToDiscard: true,
    });
  }

  if (body.action === 'call_trump') {
    if (round !== 2) return fail(409, 'wrong_round', 'call_trump only in round 2');
    if (!body.suit || !VALID_SUITS.includes(body.suit)) {
      return fail(400, 'bad_suit', 'suit must be C/D/H/S');
    }
    if (body.suit === upcardSuit) {
      return fail(409, 'suit_excluded', 'Cannot call trump matching the turned-down upcard');
    }
    return await acceptBid(admin, game.id, eu, {
      maker: seat,
      alone: body.alone === true ? seat : null,
      trump: body.suit,
      goingToDiscard: false,
    });
  }

  return fail(400, 'bad_action', 'unhandled');
});

async function handleBidProgression(
  admin: ReturnType<typeof adminClient>,
  gameId: string,
  eu: Awaited<ReturnType<typeof loadEuchreState>> & object,
  seat: Seat,
  dealer: Seat,
  round: 1 | 2,
) {
  // count passes in this round = users seated between (dealer+1 round 1, dealer+1 round 2) and current.
  // Easier: derive "is this the last bidder?" — round 1 last bidder is the dealer; round 2 last bidder is also the dealer.
  // After dealer passes in round 1, advance to round 2 (turn upcard down).
  // After dealer in round 2 — covered by stick-the-dealer above (cannot pass).
  const isLastInRound = seat === dealer;

  if (round === 1 && isLastInRound) {
    const next = ((dealer + 1) % 4) as Seat;
    const { error: euErr } = await admin
      .from('euchre_games')
      .update({ upcard_status: 'turned_down' })
      .eq('game_id', gameId);
    if (euErr) return fail(500, 'db_eu_update', euErr.message);

    const { error: gErr } = await admin
      .from('games')
      .update({ current_seat: next, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
      .eq('id', gameId);
    if (gErr) return fail(500, 'db_game_update', gErr.message);

    await admin.from('game_actions').insert({
      game_id: gameId,
      seat,
      action_type: 'pass',
      payload: { round, advanced_to_round_2: true },
    });
    await autoAdvanceBots(admin, gameId);
    return json({ ok: true, advanced: 'round_2', next_seat: next });
  }

  // Normal pass: advance to the next seat.
  const next = ((seat + 1) % 4) as Seat;
  const { error: gErr } = await admin
    .from('games')
    .update({ current_seat: next, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
    .eq('id', gameId);
  if (gErr) return fail(500, 'db_game_update', gErr.message);

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat,
    action_type: 'pass',
    payload: { round },
  });
  await autoAdvanceBots(admin, gameId);
  return json({ ok: true, next_seat: next });
}

interface AcceptBid {
  maker: Seat;
  alone: Seat | null;
  trump: Suit;
  goingToDiscard: boolean;
}

async function acceptBid(
  admin: ReturnType<typeof adminClient>,
  gameId: string,
  eu: Awaited<ReturnType<typeof loadEuchreState>> & object,
  bid: AcceptBid,
) {
  const dealer = eu.dealer_seat as Seat;

  if (bid.goingToDiscard) {
    // Order-up: dealer must discard before play starts.
    // Move upcard into dealer's hand.
    const { data: dealerHand, error: hErr } = await admin
      .from('game_hands')
      .select('cards')
      .eq('game_id', gameId)
      .eq('seat', dealer)
      .single();
    if (hErr) return fail(500, 'db_hand_load', hErr.message);

    if (!eu.upcard) return fail(500, 'no_upcard', 'No upcard');
    const newCards = [...(dealerHand.cards as Card[]), eu.upcard];

    const { error: uHErr } = await admin
      .from('game_hands')
      .update({ cards: newCards })
      .eq('game_id', gameId)
      .eq('seat', dealer);
    if (uHErr) return fail(500, 'db_hand_update', uHErr.message);

    const { error: euErr } = await admin
      .from('euchre_games')
      .update({
        trump_suit: bid.trump,
        maker_seat: bid.maker,
        alone_seat: bid.alone,
        upcard_status: 'taken',
      })
      .eq('game_id', gameId);
    if (euErr) return fail(500, 'db_eu_update', euErr.message);

    const { error: gErr } = await admin
      .from('games')
      .update({ current_seat: dealer, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
      .eq('id', gameId);
    if (gErr) return fail(500, 'db_game_update', gErr.message);

    await admin.from('game_actions').insert({
      game_id: gameId,
      seat: bid.maker,
      action_type: 'order_up',
      payload: { trump: bid.trump, alone: bid.alone !== null },
    });
    await autoAdvanceBots(admin, gameId);
    return json({ ok: true, phase: 'discard', trump: bid.trump, dealer });
  }

  // call_trump path: go straight to play. Clear the leftover upcard —
  // playCard treats non-null upcard as "still in discard phase" and
  // rejects, which would freeze the game on every play attempt.
  const first = nextSeat(dealer, bid.alone);
  const { error: euErr } = await admin
    .from('euchre_games')
    .update({
      trump_suit: bid.trump,
      maker_seat: bid.maker,
      alone_seat: bid.alone,
      upcard: null,
    })
    .eq('game_id', gameId);
  if (euErr) return fail(500, 'db_eu_update', euErr.message);

  const { error: gErr } = await admin
    .from('games')
    .update({ current_seat: first, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
    .eq('id', gameId);
  if (gErr) return fail(500, 'db_game_update', gErr.message);

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: bid.maker,
    action_type: 'call_trump',
    payload: { trump: bid.trump, alone: bid.alone !== null },
  });
  await autoAdvanceBots(admin, gameId);
  return json({ ok: true, phase: 'play', trump: bid.trump, current_seat: first });
}
