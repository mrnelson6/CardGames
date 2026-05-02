// Server-side Euchre rule engine (Deno).
// Mirrors src/games/euchre/{cards,game-machine}.ts. Keep these in sync.

export type Suit = 'C' | 'D' | 'H' | 'S';
export type Rank = '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Rank}${Suit}`;
export type Seat = 0 | 1 | 2 | 3;
export type Team = 0 | 1;

export const SUITS: readonly Suit[] = ['C', 'D', 'H', 'S'];
export const RANKS: readonly Rank[] = ['9', 'T', 'J', 'Q', 'K', 'A'];

export const LEFT_BOWER_SUIT: Record<Suit, Suit> = { C: 'S', S: 'C', D: 'H', H: 'D' };

export const teamOf = (seat: Seat): Team => (seat % 2) as Team;

export function suitOf(card: Card): Suit {
  return card[1] as Suit;
}
export function rankOf(card: Card): Rank {
  return card[0] as Rank;
}

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

export function nextSeat(seat: Seat, alone: Seat | null): Seat {
  let n = ((seat + 1) % 4) as Seat;
  if (alone !== null && n === ((alone + 2) % 4)) {
    n = ((n + 1) % 4) as Seat;
  }
  return n;
}

export function buildDeck(): Card[] {
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

export interface DealResult {
  hands: [Card[], Card[], Card[], Card[]];
  upcard: Card;
}

export function dealEuchre(rand: () => number = Math.random): DealResult {
  const deck = shuffle(buildDeck(), rand);
  return {
    hands: [deck.slice(0, 5), deck.slice(5, 10), deck.slice(10, 15), deck.slice(15, 20)],
    upcard: deck[20],
  };
}

// ELO --------------------------------------------------------------------------

export interface EloPlayer {
  rating: number;
  gamesPlayed: number;
}

export function expectedScore(rating: number, oppAvg: number): number {
  return 1 / (1 + Math.pow(10, (oppAvg - rating) / 400));
}

export function eloKFactor(gamesPlayed: number): number {
  return gamesPlayed < 10 ? 32 : 16;
}

export function applyEloUpdate(p: EloPlayer, oppAvg: number, won: boolean): number {
  const E = expectedScore(p.rating, oppAvg);
  const S = won ? 1 : 0;
  const K = eloKFactor(p.gamesPlayed);
  return Math.round(p.rating + K * (S - E));
}

// Hand scoring -----------------------------------------------------------------

export interface HandScoreInput {
  makerTeam: Team;
  makerTricks: number;
  alone: boolean;
}

export interface HandScoreResult {
  team: Team;
  points: number;
}

export function scoreHandResult(input: HandScoreInput): HandScoreResult {
  const { makerTeam, makerTricks, alone } = input;
  const otherTeam = (1 - makerTeam) as Team;
  if (makerTricks >= 3) {
    if (makerTricks === 5) return { team: makerTeam, points: alone ? 4 : 2 };
    return { team: makerTeam, points: 1 };
  }
  return { team: otherTeam, points: 2 };
}
