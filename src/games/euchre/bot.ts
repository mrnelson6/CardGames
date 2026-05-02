import type { Card, Suit } from '../../lib/database.types';
import { rankOf, suitOf } from '../../lib/cards-base';
import { effectiveSuit, isLeftBower, isRightBower, legalPlays, cardStrength } from './cards';

export function shouldOrderUp(hand: Card[], upcardSuit: Suit): boolean {
  let trumpCount = 0;
  let bowerCount = 0;
  for (const c of hand) {
    if (effectiveSuit(c, upcardSuit) === upcardSuit) trumpCount++;
    if (isRightBower(c, upcardSuit) || isLeftBower(c, upcardSuit)) bowerCount++;
  }
  if (trumpCount >= 3 && bowerCount >= 1) return true;
  const offSuitAce = hand.some((c) => rankOf(c) === 'A' && effectiveSuit(c, upcardSuit) !== upcardSuit);
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
    const offAces = legal.filter((c) => rankOf(c) === 'A' && effectiveSuit(c, trump) !== trump);
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
