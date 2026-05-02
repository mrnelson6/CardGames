// Server-side Euchre bot heuristic. Mirrors src/games/euchre/bot.ts but is
// also responsible for the discard pick (clients didn't need that).

import {
  type Card,
  type Suit,
  cardStrength,
  effectiveSuit,
  isLeftBower,
  isRightBower,
  legalPlays,
  rankOf,
  suitOf,
} from './euchre.ts';

export function shouldOrderUp(hand: Card[], upcardSuit: Suit): boolean {
  let trumpCount = 0;
  let bowerCount = 0;
  for (const c of hand) {
    if (effectiveSuit(c, upcardSuit) === upcardSuit) trumpCount++;
    if (isRightBower(c, upcardSuit) || isLeftBower(c, upcardSuit)) bowerCount++;
  }
  if (trumpCount >= 3 && bowerCount >= 1) return true;
  const offSuitAce = hand.some(
    (c) => rankOf(c) === 'A' && effectiveSuit(c, upcardSuit) !== upcardSuit,
  );
  if (trumpCount >= 2 && offSuitAce) return true;
  return false;
}

export function pickBotPlay(
  hand: Card[],
  ledCard: Card | null,
  trump: Suit,
  partnerWinning: boolean,
): Card {
  const legal = legalPlays(hand, ledCard, trump);

  if (ledCard === null) {
    const offAces = legal.filter(
      (c) => rankOf(c) === 'A' && effectiveSuit(c, trump) !== trump,
    );
    if (offAces.length > 0) return offAces[0];
    const nonTrump = legal.filter((c) => effectiveSuit(c, trump) !== trump);
    if (nonTrump.length > 0) {
      return nonTrump.reduce((lo, c) =>
        cardStrength(c, trump, suitOf(c)) < cardStrength(lo, trump, suitOf(lo)) ? c : lo,
      );
    }
    return legal.reduce((lo, c) =>
      cardStrength(c, trump, trump) < cardStrength(lo, trump, trump) ? c : lo,
    );
  }

  const ledSuit = effectiveSuit(ledCard, trump);
  if (partnerWinning) {
    return legal.reduce((lo, c) =>
      cardStrength(c, trump, ledSuit) < cardStrength(lo, trump, ledSuit) ? c : lo,
    );
  }
  return legal.reduce((hi, c) =>
    cardStrength(c, trump, ledSuit) > cardStrength(hi, trump, ledSuit) ? c : hi,
  );
}

// Dealer's discard pick after order-up: drop lowest non-trump if any, else
// lowest trump that isn't a bower (don't throw away strength).
export function pickBotDiscard(hand: Card[], trump: Suit): Card {
  const nonTrump = hand.filter((c) => effectiveSuit(c, trump) !== trump);
  if (nonTrump.length > 0) {
    return nonTrump.reduce((lo, c) =>
      cardStrength(c, trump, suitOf(c)) < cardStrength(lo, trump, suitOf(lo)) ? c : lo,
    );
  }
  const nonBowerTrump = hand.filter(
    (c) => !isRightBower(c, trump) && !isLeftBower(c, trump),
  );
  if (nonBowerTrump.length > 0) {
    return nonBowerTrump.reduce((lo, c) =>
      cardStrength(c, trump, trump) < cardStrength(lo, trump, trump) ? c : lo,
    );
  }
  // All trump and all bowers — just drop the weakest trump.
  return hand.reduce((lo, c) =>
    cardStrength(c, trump, trump) < cardStrength(lo, trump, trump) ? c : lo,
  );
}
