// Shared mutation helpers for Euchre. Both human-facing handlers and the
// bot/timeout path go through these so the rules are enforced identically.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  type Card,
  type Seat,
  type Suit,
  type Team,
  effectiveSuit,
  legalPlays,
  nextSeat,
  scoreHandResult,
  suitOf,
  teamOf,
  trickWinner,
} from './euchre.ts';
import {
  HAND_END_PAUSE_MS,
  TURN_SECONDS,
  buildDealForHand,
  deadlineNowPlus,
  type EuchreRow,
  type FullGame,
  type HandRow,
  type PlayerRow,
  type TrickPlayRow,
  type TrickRow,
} from './state.ts';
import { applyEloOnGameEnd } from './elo.ts';

const WIN_SCORE = 10;

export interface ActionResult {
  ok: true;
  phase: 'bid_round_1' | 'bid_round_2' | 'discard' | 'play' | 'finished';
  current_seat: number | null;
}

// ----- pass --------------------------------------------------------------------

export async function passBid(
  admin: SupabaseClient,
  gameId: string,
  eu: EuchreRow,
  seat: Seat,
): Promise<ActionResult | { error: string }> {
  if (eu.trump_suit !== null) return { error: 'not_bidding' };
  if (!eu.upcard) return { error: 'no_upcard' };
  const round: 1 | 2 = eu.upcard_status === 'face_up' ? 1 : 2;
  const dealer = eu.dealer_seat as Seat;

  if (round === 2 && seat === dealer) return { error: 'stick_the_dealer' };

  const isLastInRound = seat === dealer;
  if (round === 1 && isLastInRound) {
    const next = ((dealer + 1) % 4) as Seat;
    const upd = await admin
      .from('euchre_games')
      .update({ upcard_status: 'turned_down' })
      .eq('game_id', gameId);
    if (upd.error) return { error: upd.error.message };

    const g = await admin
      .from('games')
      .update({ current_seat: next, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
      .eq('id', gameId);
    if (g.error) return { error: g.error.message };

    await admin.from('game_actions').insert({
      game_id: gameId,
      seat,
      action_type: 'pass',
      payload: { round, advanced_to_round_2: true },
    });
    return { ok: true, phase: 'bid_round_2', current_seat: next };
  }

  const next = ((seat + 1) % 4) as Seat;
  const g = await admin
    .from('games')
    .update({ current_seat: next, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
    .eq('id', gameId);
  if (g.error) return { error: g.error.message };

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat,
    action_type: 'pass',
    payload: { round },
  });

  return {
    ok: true,
    phase: round === 1 ? 'bid_round_1' : 'bid_round_2',
    current_seat: next,
  };
}

// ----- order_up / call_trump ---------------------------------------------------

export interface AcceptBidArgs {
  maker: Seat;
  alone: Seat | null;
  trump: Suit;
  goingToDiscard: boolean;
}

export async function acceptBid(
  admin: SupabaseClient,
  gameId: string,
  eu: EuchreRow,
  bid: AcceptBidArgs,
): Promise<ActionResult | { error: string }> {
  const dealer = eu.dealer_seat as Seat;

  if (bid.goingToDiscard) {
    if (!eu.upcard) return { error: 'no_upcard' };
    const { data: dealerHand, error: hErr } = await admin
      .from('game_hands')
      .select('cards')
      .eq('game_id', gameId)
      .eq('seat', dealer)
      .single();
    if (hErr) return { error: hErr.message };

    const newCards = [...(dealerHand.cards as Card[]), eu.upcard];
    const uH = await admin
      .from('game_hands')
      .update({ cards: newCards })
      .eq('game_id', gameId)
      .eq('seat', dealer);
    if (uH.error) return { error: uH.error.message };

    const euUpd = await admin
      .from('euchre_games')
      .update({
        trump_suit: bid.trump,
        maker_seat: bid.maker,
        alone_seat: bid.alone,
        upcard_status: 'taken',
      })
      .eq('game_id', gameId);
    if (euUpd.error) return { error: euUpd.error.message };

    const g = await admin
      .from('games')
      .update({ current_seat: dealer, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
      .eq('id', gameId);
    if (g.error) return { error: g.error.message };

    await admin.from('game_actions').insert({
      game_id: gameId,
      seat: bid.maker,
      action_type: 'order_up',
      payload: { trump: bid.trump, alone: bid.alone !== null },
    });
    return { ok: true, phase: 'discard', current_seat: dealer };
  }

  const first = nextSeat(dealer, bid.alone);
  const euUpd = await admin
    .from('euchre_games')
    .update({
      trump_suit: bid.trump,
      maker_seat: bid.maker,
      alone_seat: bid.alone,
      // Clear the leftover turned-down upcard. playCard refuses to act
      // when upcard is non-null (it's the discard-phase signal); without
      // this, every play attempt after a round-2 call_trump fails.
      upcard: null,
    })
    .eq('game_id', gameId);
  if (euUpd.error) return { error: euUpd.error.message };

  const g = await admin
    .from('games')
    .update({ current_seat: first, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
    .eq('id', gameId);
  if (g.error) return { error: g.error.message };

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: bid.maker,
    action_type: 'call_trump',
    payload: { trump: bid.trump, alone: bid.alone !== null },
  });
  return { ok: true, phase: 'play', current_seat: first };
}

// ----- discard ----------------------------------------------------------------

export async function dealerDiscard(
  admin: SupabaseClient,
  gameId: string,
  eu: EuchreRow,
  card: Card,
): Promise<ActionResult | { error: string }> {
  const dealer = eu.dealer_seat as Seat;
  const { data: hand, error: hErr } = await admin
    .from('game_hands')
    .select('cards')
    .eq('game_id', gameId)
    .eq('seat', dealer)
    .single();
  if (hErr) return { error: hErr.message };

  const cards = hand.cards as Card[];
  const idx = cards.indexOf(card);
  if (idx === -1) return { error: 'card_not_held' };
  const newCards = cards.slice(0, idx).concat(cards.slice(idx + 1));
  if (newCards.length !== 5) return { error: 'hand_size' };

  const u = await admin
    .from('game_hands')
    .update({ cards: newCards, discarded_card: card })
    .eq('game_id', gameId)
    .eq('seat', dealer);
  if (u.error) return { error: u.error.message };

  const first = nextSeat(dealer, eu.alone_seat as Seat | null);

  const euUpd = await admin
    .from('euchre_games')
    .update({ upcard: null })
    .eq('game_id', gameId);
  if (euUpd.error) return { error: euUpd.error.message };

  const g = await admin
    .from('games')
    .update({ current_seat: first, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
    .eq('id', gameId);
  if (g.error) return { error: g.error.message };

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: dealer,
    action_type: 'discard',
    payload: {},
  });
  return { ok: true, phase: 'play', current_seat: first };
}

// ----- play_card --------------------------------------------------------------

export async function playCard(
  admin: SupabaseClient,
  gameId: string,
  game: FullGame,
  eu: EuchreRow,
  players: PlayerRow[],
  seat: Seat,
  card: Card,
): Promise<ActionResult | { error: string }> {
  if (eu.trump_suit === null) return { error: 'not_play_phase' };
  if (eu.upcard !== null) return { error: 'not_play_phase' };
  const trump = eu.trump_suit as Suit;
  const alone = eu.alone_seat as Seat | null;

  const { data: myHand, error: hErr } = await admin
    .from('game_hands')
    .select('cards')
    .eq('game_id', gameId)
    .eq('seat', seat)
    .single();
  if (hErr) return { error: hErr.message };

  const cards = myHand.cards as Card[];
  if (!cards.includes(card)) return { error: 'card_not_held' };

  const trick = await loadCurrentTrickData(admin, eu.current_trick_id);
  const ledCard: Card | null = trick?.plays?.[0]?.card ?? null;
  const legal = legalPlays(cards, ledCard, trump);
  if (!legal.includes(card)) return { error: 'illegal_play' };

  let trickId = eu.current_trick_id;
  let trickNumber = trick?.row?.trick_number ?? 0;

  if (trickId === null) {
    const { data: prev, error: prevErr } = await admin
      .from('tricks')
      .select('trick_number')
      .eq('game_id', gameId)
      .eq('hand_number', eu.hand_number)
      .order('trick_number', { ascending: false })
      .limit(1);
    if (prevErr) return { error: prevErr.message };
    trickNumber = (prev?.[0]?.trick_number ?? 0) + 1;

    const { data: newTrick, error: tErr } = await admin
      .from('tricks')
      .insert({
        game_id: gameId,
        hand_number: eu.hand_number,
        trick_number: trickNumber,
        lead_seat: seat,
        led_suit: effectiveSuit(card, trump),
      })
      .select('id')
      .single();
    if (tErr) return { error: tErr.message };
    trickId = newTrick.id;

    const euTUpd = await admin
      .from('euchre_games')
      .update({ current_trick_id: trickId })
      .eq('game_id', gameId);
    if (euTUpd.error) return { error: euTUpd.error.message };
  }

  const insertPlay = await admin.from('trick_plays').insert({
    trick_id: trickId,
    seat,
    card,
  });
  if (insertPlay.error) {
    if (insertPlay.error.code === '23505') return { error: 'already_played' };
    return { error: insertPlay.error.message };
  }

  const newHand = cards.slice();
  newHand.splice(newHand.indexOf(card), 1);
  const uH = await admin
    .from('game_hands')
    .update({ cards: newHand })
    .eq('game_id', gameId)
    .eq('seat', seat);
  if (uH.error) return { error: uH.error.message };

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat,
    action_type: 'play_card',
    payload: { card, trick_id: trickId, trick_number: trickNumber },
  });

  const expectedPlays = alone !== null ? 3 : 4;
  const newPlayCount = (trick?.plays?.length ?? 0) + 1;

  if (newPlayCount < expectedPlays) {
    const next = nextSeat(seat, alone);
    const g = await admin
      .from('games')
      .update({ current_seat: next, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
      .eq('id', gameId);
    if (g.error) return { error: g.error.message };
    return { ok: true, phase: 'play', current_seat: next };
  }

  // Resolve trick.
  const allPlays = [...(trick?.plays ?? []), { trick_id: trickId, seat, card } as TrickPlayRow];
  const winner = trickWinner(allPlays.map((p) => ({ seat: p.seat, card: p.card })), trump) as Seat;

  const tWUpd = await admin
    .from('tricks')
    .update({ winner_seat: winner })
    .eq('id', trickId);
  if (tWUpd.error) return { error: tWUpd.error.message };

  const euCUpd = await admin
    .from('euchre_games')
    .update({ current_trick_id: null })
    .eq('game_id', gameId);
  if (euCUpd.error) return { error: euCUpd.error.message };

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: winner,
    action_type: 'trick_complete',
    payload: { trick_number: trickNumber, winner_seat: winner },
  });

  if (trickNumber < 5) {
    const g = await admin
      .from('games')
      .update({ current_seat: winner, turn_deadline: deadlineNowPlus(TURN_SECONDS) })
      .eq('id', gameId);
    if (g.error) return { error: g.error.message };
    return { ok: true, phase: 'play', current_seat: winner };
  }

  // Hand complete.
  return await resolveHandEnd(admin, gameId, eu, players, game);
}

async function resolveHandEnd(
  admin: SupabaseClient,
  gameId: string,
  eu: EuchreRow,
  players: PlayerRow[],
  game: FullGame,
): Promise<ActionResult | { error: string }> {
  if (eu.maker_seat === null) return { error: 'no_maker' };
  const makerSeat = eu.maker_seat as Seat;
  const makerTeam = teamOf(makerSeat);
  const handNumber = eu.hand_number;
  const dealer = eu.dealer_seat as Seat;
  const alone = eu.alone_seat as Seat | null;

  const { data: tricksThisHand, error: tErr } = await admin
    .from('tricks')
    .select('winner_seat')
    .eq('game_id', gameId)
    .eq('hand_number', handNumber);
  if (tErr) return { error: tErr.message };

  let makerTricks = 0;
  for (const t of tricksThisHand ?? []) {
    if (t.winner_seat !== null && teamOf(t.winner_seat as Seat) === makerTeam) makerTricks += 1;
  }
  const result = scoreHandResult({ makerTeam, makerTricks, alone: alone !== null });

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
    const winningTeam: Team = (team0 >= WIN_SCORE ? 0 : 1) as Team;
    const fin = await admin
      .from('games')
      .update({
        team0_score: team0,
        team1_score: team1,
        status: 'finished',
        current_seat: null,
        turn_deadline: null,
      })
      .eq('id', gameId);
    if (fin.error) return { error: fin.error.message };

    await admin.from('game_actions').insert({
      game_id: gameId,
      seat: null,
      action_type: 'game_complete',
      payload: { winning_team: winningTeam, team0, team1 },
    });

    // ELO update (no-op for unranked games where game.mode is null).
    await applyEloOnGameEnd(admin, game, players, winningTeam);

    return { ok: true, phase: 'finished', current_seat: null };
  }

  // Hold the just-completed last trick on screen for a beat before the new
  // face-up card replaces it. Without this pause the new hand deals
  // instantly and the held visualization disappears the moment it appears.
  await new Promise((r) => setTimeout(r, HAND_END_PAUSE_MS));

  // Deal next hand.
  const nextDealer = ((dealer + 1) % 4) as Seat;
  const deal = buildDealForHand(gameId, players, nextDealer, handNumber + 1);

  const dH = await admin.from('game_hands').upsert(deal.hands);
  if (dH.error) return { error: dH.error.message };

  const euUpd = await admin
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
  if (euUpd.error) return { error: euUpd.error.message };

  const g = await admin
    .from('games')
    .update({
      team0_score: team0,
      team1_score: team1,
      current_seat: deal.current_seat,
      turn_deadline: deal.turn_deadline,
    })
    .eq('id', gameId);
  if (g.error) return { error: g.error.message };

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: nextDealer,
    action_type: 'deal_hand',
    payload: { hand_number: handNumber + 1, dealer_seat: nextDealer },
  });

  return { ok: true, phase: 'bid_round_1', current_seat: deal.current_seat };
}

async function loadCurrentTrickData(
  admin: SupabaseClient,
  trickId: string | null,
): Promise<{ row: TrickRow | null; plays: TrickPlayRow[] } | null> {
  if (!trickId) return null;
  const [{ data: row }, { data: plays }] = await Promise.all([
    admin.from('tricks').select('*').eq('id', trickId).maybeSingle(),
    admin.from('trick_plays').select('*').eq('trick_id', trickId).order('played_at'),
  ]);
  return { row: row as TrickRow | null, plays: (plays ?? []) as TrickPlayRow[] };
}

// re-exports
export { effectiveSuit, suitOf };
