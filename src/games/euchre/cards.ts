import type { Card, Suit } from '../../lib/database.types';
import { rankOf, suitOf } from '../../lib/cards-base';

export const LEFT_BOWER_SUIT: Record<Suit, Suit> = {
  C: 'S',
  S: 'C',
  D: 'H',
  H: 'D',
};

export function isRightBower(card: Card, trump: Suit): boolean {
  return rankOf(card) === 'J' && suitOf(card) === trump;
}

export function isLeftBower(card: Card, trump: Suit): boolean {
  return rankOf(card) === 'J' && suitOf(card) === LEFT_BOWER_SUIT[trump];
}

export function effectiveSuit(card: Card, trump: Suit): Suit {
  if (isLeftBower(card, trump)) return trump;
  return suitOf(card);
}

export function isTrump(card: Card, trump: Suit): boolean {
  return effectiveSuit(card, trump) === trump;
}

const NON_TRUMP_ORDER: Record<string, number> = {
  '9': 0, T: 1, J: 2, Q: 3, K: 4, A: 5,
};

export function cardStrength(card: Card, trump: Suit, ledSuit: Suit | null): number {
  const eff = effectiveSuit(card, trump);
  if (eff === trump) {
    if (isRightBower(card, trump)) return 100;
    if (isLeftBower(card, trump)) return 99;
    return 80 + NON_TRUMP_ORDER[rankOf(card)];
  }
  if (ledSuit !== null && eff === ledSuit) {
    return 50 + NON_TRUMP_ORDER[rankOf(card)];
  }
  return NON_TRUMP_ORDER[rankOf(card)];
}

export function legalPlays(hand: Card[], ledCard: Card | null, trump: Suit): Card[] {
  if (ledCard === null) return hand.slice();
  const ledSuit = effectiveSuit(ledCard, trump);
  const mustFollow = hand.filter((c) => effectiveSuit(c, trump) === ledSuit);
  return mustFollow.length > 0 ? mustFollow : hand.slice();
}

export function trickWinner(plays: Array<{ seat: number; card: Card }>, trump: Suit): number {
  const led = plays[0].card;
  const ledSuit = effectiveSuit(led, trump);
  let bestSeat = plays[0].seat;
  let bestStrength = cardStrength(led, trump, ledSuit);
  for (let i = 1; i < plays.length; i++) {
    const s = cardStrength(plays[i].card, trump, ledSuit);
    if (s > bestStrength) {
      bestStrength = s;
      bestSeat = plays[i].seat;
    }
  }
  return bestSeat;
}
