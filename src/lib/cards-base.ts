import type { Card, Rank, Suit } from './database.types';

export const SUITS: readonly Suit[] = ['C', 'D', 'H', 'S'];
export const RANKS: readonly Rank[] = ['9', 'T', 'J', 'Q', 'K', 'A'];

export const SUIT_LABEL: Record<Suit, string> = {
  C: '♣',
  D: '♦',
  H: '♥',
  S: '♠',
};

export const RANK_LABEL: Record<Rank, string> = {
  '9': '9',
  T: '10',
  J: 'J',
  Q: 'Q',
  K: 'K',
  A: 'A',
};

export function suitOf(card: Card): Suit {
  return card[1] as Suit;
}

export function rankOf(card: Card): Rank {
  return card[0] as Rank;
}

export function isRed(suit: Suit): boolean {
  return suit === 'D' || suit === 'H';
}

export function buildEuchreDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push(`${r}${s}` as Card);
    }
  }
  return deck;
}

export function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
