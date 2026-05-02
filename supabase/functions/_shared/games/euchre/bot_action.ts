// Plays a single bot move at the current seat. Routes by phase to the
// shared action helpers. Used by enforce-timeout (when a human times out)
// and by the auto-advance loop (when current_seat is_bot).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  type Card,
  type Seat,
  type Suit,
  effectiveSuit,
  suitOf,
  teamOf,
  trickWinner,
} from './euchre.ts';
import { pickBotDiscard, pickBotPlay, shouldOrderUp } from './bot.ts';
import {
  type ActionResult,
  acceptBid,
  dealerDiscard,
  passBid,
  playCard,
} from './actions.ts';
import {
  type EuchreRow,
  type FullGame,
  type PlayerRow,
  type TrickPlayRow,
} from './state.ts';

export async function executeBotMove(
  admin: SupabaseClient,
  game: FullGame,
  eu: EuchreRow,
  players: PlayerRow[],
  seat: Seat,
): Promise<ActionResult | { error: string }> {
  // Bidding round 1 / 2.
  if (eu.trump_suit === null) {
    if (!eu.upcard) return { error: 'no_upcard' };
    const upcardSuit = suitOf(eu.upcard);
    const round: 1 | 2 = eu.upcard_status === 'face_up' ? 1 : 2;
    const dealer = eu.dealer_seat as Seat;

    const { data: hand, error: hErr } = await admin
      .from('game_hands')
      .select('cards')
      .eq('game_id', game.id)
      .eq('seat', seat)
      .single();
    if (hErr) return { error: hErr.message };
    const cards = hand.cards as Card[];

    if (round === 1) {
      if (shouldOrderUp(cards, upcardSuit)) {
        return await acceptBid(admin, game.id, eu, {
          maker: seat,
          alone: null,
          trump: upcardSuit,
          goingToDiscard: true,
        });
      }
      // Otherwise pass.
      return await passBid(admin, game.id, eu, seat);
    }

    // Round 2: pick a non-upcard suit if we'd order up; else pass.
    const candidateSuits: Suit[] = (['C', 'D', 'H', 'S'] as Suit[]).filter(
      (s) => s !== upcardSuit,
    );
    let bestSuit: Suit | null = null;
    let bestScore = -1;
    for (const s of candidateSuits) {
      let trumpCount = 0;
      for (const c of cards) if (effectiveSuit(c, s) === s) trumpCount++;
      if (trumpCount > bestScore) { bestScore = trumpCount; bestSuit = s; }
    }
    // Stick the dealer is enforced by passBid — dealer cannot pass in round 2.
    if (seat === dealer || (bestSuit !== null && bestScore >= 3)) {
      return await acceptBid(admin, game.id, eu, {
        maker: seat,
        alone: null,
        trump: bestSuit ?? candidateSuits[0],
        goingToDiscard: false,
      });
    }
    return await passBid(admin, game.id, eu, seat);
  }

  // Discard phase.
  if (eu.upcard !== null && eu.upcard_status === 'taken') {
    const dealer = eu.dealer_seat as Seat;
    if (seat !== dealer) return { error: 'discard_seat_mismatch' };
    const trump = eu.trump_suit as Suit;
    const { data: hand, error: hErr } = await admin
      .from('game_hands')
      .select('cards')
      .eq('game_id', game.id)
      .eq('seat', dealer)
      .single();
    if (hErr) return { error: hErr.message };
    const card = pickBotDiscard(hand.cards as Card[], trump);
    return await dealerDiscard(admin, game.id, eu, card);
  }

  // Play phase.
  const trump = eu.trump_suit as Suit;
  const { data: myHand, error: hErr } = await admin
    .from('game_hands')
    .select('cards')
    .eq('game_id', game.id)
    .eq('seat', seat)
    .single();
  if (hErr) return { error: hErr.message };
  const cards = myHand.cards as Card[];

  // Look up the led card if a trick is in progress.
  let ledCard: Card | null = null;
  let plays: TrickPlayRow[] = [];
  if (eu.current_trick_id) {
    const { data } = await admin
      .from('trick_plays')
      .select('*')
      .eq('trick_id', eu.current_trick_id)
      .order('played_at');
    plays = (data ?? []) as TrickPlayRow[];
    if (plays.length > 0) ledCard = plays[0].card;
  }

  const partnerWinning = isPartnerWinning(seat, plays, trump);
  const card = pickBotPlay(cards, ledCard, trump, partnerWinning);
  return await playCard(admin, game.id, game, eu, players, seat, card);
}

function isPartnerWinning(seat: Seat, plays: TrickPlayRow[], trump: Suit): boolean {
  if (plays.length === 0) return false;
  const winnerSeat = trickWinner(plays.map((p) => ({ seat: p.seat, card: p.card })), trump);
  return teamOf(winnerSeat as Seat) === teamOf(seat);
}
