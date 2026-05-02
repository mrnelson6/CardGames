// POST /functions/v1/euchre-play-card
// Body: { game_id, card }
// Authoritative card-play handler: validates the move, advances the trick, resolves hand/game.
// ELO updates intentionally deferred to Phase 4 — private rooms are unranked.

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
  effectiveSuit,
  legalPlays,
  nextSeat,
  scoreHandResult,
  teamOf,
  trickWinner,
} from '../_shared/games/euchre/euchre.ts';
import {
  HAND_END_PAUSE_MS,
  TURN_SECONDS,
  buildDealForHand,
  deadlineNowPlus,
  loadCurrentTrick,
  loadEuchreState,
  loadGame,
  loadPlayers,
} from '../_shared/games/euchre/state.ts';
import { autoAdvanceBots } from '../_shared/games/euchre/auto_advance.ts';
import { applyEloOnGameEnd } from '../_shared/games/euchre/elo.ts';

interface Body {
  game_id: string;
  card: Card;
}

const WIN_SCORE = 10;

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
  if (eu.trump_suit === null) return fail(409, 'not_play_phase', 'Bidding not complete');
  if (eu.upcard !== null) return fail(409, 'not_play_phase', 'Dealer must discard first');

  const players = await loadPlayers(admin, body.game_id);
  const me = players.find((p) => p.user_id === user.id);
  if (!me) return fail(403, 'not_seated', 'You are not at this table');
  if (game.current_seat !== me.seat) return fail(409, 'not_your_turn', 'Not your turn');

  const seat = me.seat as Seat;
  const trump = eu.trump_suit as Suit;
  const alone = eu.alone_seat as Seat | null;

  // Load my hand and the current trick (if any).
  const { data: myHand, error: hErr } = await admin
    .from('game_hands')
    .select('cards')
    .eq('game_id', body.game_id)
    .eq('seat', seat)
    .single();
  if (hErr) return fail(500, 'db_hand_load', hErr.message);

  const cards = myHand.cards as Card[];
  if (!cards.includes(body.card)) return fail(400, 'card_not_held', 'Card is not in your hand');

  const { trick, plays } = await loadCurrentTrick(admin, eu.current_trick_id);
  const ledCard: Card | null = plays.length > 0 ? plays[0].card : null;
  const legal = legalPlays(cards, ledCard, trump);
  if (!legal.includes(body.card)) {
    return fail(409, 'illegal_play', 'Must follow led suit if able');
  }

  // Determine current trick number and create trick row if needed.
  let trickId = eu.current_trick_id;
  let trickNumber = trick?.trick_number ?? 0;
  let leadSeat = trick?.lead_seat ?? seat;

  if (trickId === null) {
    // Compute next trick_number for this hand (1..5).
    const { data: prev, error: prevErr } = await admin
      .from('tricks')
      .select('trick_number')
      .eq('game_id', body.game_id)
      .eq('hand_number', eu.hand_number)
      .order('trick_number', { ascending: false })
      .limit(1);
    if (prevErr) return fail(500, 'db_trick_count', prevErr.message);
    trickNumber = (prev?.[0]?.trick_number ?? 0) + 1;
    leadSeat = seat;

    const { data: newTrick, error: tErr } = await admin
      .from('tricks')
      .insert({
        game_id: body.game_id,
        hand_number: eu.hand_number,
        trick_number: trickNumber,
        lead_seat: leadSeat,
        led_suit: effectiveSuit(body.card, trump),
      })
      .select('id')
      .single();
    if (tErr) return fail(500, 'db_trick_create', tErr.message);
    trickId = newTrick.id;

    const { error: euTErr } = await admin
      .from('euchre_games')
      .update({ current_trick_id: trickId })
      .eq('game_id', body.game_id);
    if (euTErr) return fail(500, 'db_eu_trick_set', euTErr.message);
  }

  // Insert this play.
  const { error: pErr } = await admin.from('trick_plays').insert({
    trick_id: trickId,
    seat,
    card: body.card,
  });
  if (pErr) {
    if (pErr.code === '23505') return fail(409, 'already_played', 'You already played this trick');
    return fail(500, 'db_trick_play', pErr.message);
  }

  // Remove card from hand.
  const newHandCards = cards.slice();
  newHandCards.splice(newHandCards.indexOf(body.card), 1);
  const { error: uHErr } = await admin
    .from('game_hands')
    .update({ cards: newHandCards })
    .eq('game_id', body.game_id)
    .eq('seat', seat);
  if (uHErr) return fail(500, 'db_hand_update', uHErr.message);

  await admin.from('game_actions').insert({
    game_id: body.game_id,
    seat,
    action_type: 'play_card',
    payload: { card: body.card, trick_id: trickId, trick_number: trickNumber },
  });

  const expectedPlays = alone !== null ? 3 : 4;
  const newPlayCount = plays.length + 1;

  if (newPlayCount < expectedPlays) {
    const next = nextSeat(seat, alone);
    const { error: gErr } = await admin
      .from('games')
      .update({ current_seat: next, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
      .eq('id', body.game_id);
    if (gErr) return fail(500, 'db_game_update', gErr.message);
    await autoAdvanceBots(admin, body.game_id);
    return json({ ok: true, phase: 'play', current_seat: next });
  }

  // Trick complete — determine winner.
  const allPlays = [...plays, { trick_id: trickId, seat, card: body.card }];
  const winner = trickWinner(allPlays.map((p) => ({ seat: p.seat, card: p.card })), trump) as Seat;

  const { error: tWErr } = await admin
    .from('tricks')
    .update({ winner_seat: winner })
    .eq('id', trickId);
  if (tWErr) return fail(500, 'db_trick_winner', tWErr.message);

  // Clear current_trick_id; next play opens a new trick.
  const { error: euCErr } = await admin
    .from('euchre_games')
    .update({ current_trick_id: null })
    .eq('game_id', body.game_id);
  if (euCErr) return fail(500, 'db_eu_clear_trick', euCErr.message);

  await admin.from('game_actions').insert({
    game_id: body.game_id,
    seat: winner,
    action_type: 'trick_complete',
    payload: { trick_number: trickNumber, winner_seat: winner },
  });

  // Hand complete? Count tricks taken in this hand.
  const handDone = trickNumber === 5;
  if (!handDone) {
    const { error: gErr } = await admin
      .from('games')
      .update({ current_seat: winner, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
      .eq('id', body.game_id);
    if (gErr) return fail(500, 'db_game_update', gErr.message);
    await autoAdvanceBots(admin, body.game_id);
    return json({ ok: true, phase: 'play', current_seat: winner, trick_winner: winner });
  }

  // Hand complete — score it.
  const result = await resolveHand(admin, body.game_id, eu.hand_number, eu.maker_seat as Seat, alone, players, eu.dealer_seat as Seat);
  await autoAdvanceBots(admin, body.game_id);
  return result;
});

async function resolveHand(
  admin: ReturnType<typeof adminClient>,
  gameId: string,
  handNumber: number,
  makerSeat: Seat,
  alone: Seat | null,
  players: Awaited<ReturnType<typeof loadPlayers>>,
  dealer: Seat,
): Promise<Response> {
  const { data: tricksThisHand, error: tErr } = await admin
    .from('tricks')
    .select('winner_seat')
    .eq('game_id', gameId)
    .eq('hand_number', handNumber);
  if (tErr) return fail(500, 'db_tricks_count', tErr.message);

  const makerTeam = teamOf(makerSeat);
  let makerTricks = 0;
  for (const t of tricksThisHand ?? []) {
    if (t.winner_seat !== null && teamOf(t.winner_seat as Seat) === makerTeam) makerTricks += 1;
  }
  const result = scoreHandResult({ makerTeam, makerTricks, alone: alone !== null });

  const game = await loadGame(admin, gameId);
  if (!game) return fail(500, 'game_gone', 'Game disappeared mid-resolve');

  const team0 = result.team === 0 ? game.team0_score + result.points : game.team0_score;
  const team1 = result.team === 1 ? game.team1_score + result.points : game.team1_score;

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: makerSeat,
    action_type: 'hand_complete',
    payload: {
      hand_number: handNumber,
      maker_team: makerTeam,
      maker_tricks: makerTricks,
      points_to_team: result.team,
      points: result.points,
    },
  });

  if (team0 >= WIN_SCORE || team1 >= WIN_SCORE) {
    const winningTeam = team0 >= WIN_SCORE ? 0 : 1;
    const { error: fErr } = await admin
      .from('games')
      .update({
        team0_score: team0,
        team1_score: team1,
        status: 'finished',
        current_seat: null,
        turn_deadline: null,
      })
      .eq('id', gameId);
    if (fErr) return fail(500, 'db_finish', fErr.message);

    await admin.from('game_actions').insert({
      game_id: gameId,
      seat: null,
      action_type: 'game_complete',
      payload: { winning_team: winningTeam, team0, team1 },
    });

    // ELO update (no-op for unranked private rooms).
    const fresh = await loadGame(admin, gameId);
    if (fresh) await applyEloOnGameEnd(admin, fresh, players, winningTeam as 0 | 1);

    return json({ ok: true, phase: 'finished', winning_team: winningTeam, team0, team1 });
  }

  // Hold the just-completed last trick on screen for a beat before the new
  // face-up card replaces it.
  await new Promise((r) => setTimeout(r, HAND_END_PAUSE_MS));

  // Deal next hand.
  const nextDealer = ((dealer + 1) % 4) as Seat;
  const deal = buildDealForHand(gameId, players, nextDealer, handNumber + 1);

  const { error: dHErr } = await admin.from('game_hands').upsert(deal.hands);
  if (dHErr) return fail(500, 'db_deal_hands', dHErr.message);

  const { error: euErr } = await admin
    .from('euchre_games')
    .update({
      dealer_seat: nextDealer,
      hand_number: handNumber + 1,
      upcard: deal.euchre.upcard,
      upcard_status: deal.euchre.upcard_status,
      trump_suit: null,
      maker_seat: null,
      alone_seat: null,
      current_trick_id: null,
    })
    .eq('game_id', gameId);
  if (euErr) return fail(500, 'db_eu_next_hand', euErr.message);

  const { error: gErr } = await admin
    .from('games')
    .update({
      team0_score: team0,
      team1_score: team1,
      current_seat: deal.current_seat,
      turn_deadline: deal.turn_deadline,
    })
    .eq('id', gameId);
  if (gErr) return fail(500, 'db_game_next_hand', gErr.message);

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: nextDealer,
    action_type: 'deal_hand',
    payload: { hand_number: handNumber + 1, dealer_seat: nextDealer },
  });

  return json({
    ok: true,
    phase: 'bid_round_1',
    team0,
    team1,
    next_hand: handNumber + 1,
    current_seat: deal.current_seat,
  });
}
