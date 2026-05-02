import type { Card, Suit } from '../../lib/database.types';
import { buildEuchreDeck, shuffle } from '../../lib/cards-base';
import { effectiveSuit, legalPlays, trickWinner } from './cards';

export type Seat = 0 | 1 | 2 | 3;
export type Team = 0 | 1;

export const teamOf = (seat: Seat): Team => (seat % 2) as Team;

export type Phase =
  | 'bid_round_1'
  | 'bid_round_2'
  | 'discard'
  | 'play'
  | 'hand_complete'
  | 'game_complete';

export interface EuchreState {
  hands: Record<Seat, Card[]>;
  dealer: Seat;
  current: Seat;
  phase: Phase;
  upcard: Card | null;
  upcardStatus: 'face_up' | 'turned_down' | 'taken';
  trump: Suit | null;
  maker: Seat | null;
  alone: Seat | null;
  ledCard: Card | null;
  trick: Array<{ seat: Seat; card: Card }>;
  tricksWon: Record<Team, number>;
  scores: Record<Team, number>;
  handNumber: number;
  passesThisRound: number;
}

export function dealHand(dealer: Seat, rand: () => number = Math.random): EuchreState {
  const deck = shuffle(buildEuchreDeck(), rand);
  const hands: Record<Seat, Card[]> = {
    0: deck.slice(0, 5),
    1: deck.slice(5, 10),
    2: deck.slice(10, 15),
    3: deck.slice(15, 20),
  };
  const upcard = deck[20];
  const first = ((dealer + 1) % 4) as Seat;
  return {
    hands,
    dealer,
    current: first,
    phase: 'bid_round_1',
    upcard,
    upcardStatus: 'face_up',
    trump: null,
    maker: null,
    alone: null,
    ledCard: null,
    trick: [],
    tricksWon: { 0: 0, 1: 0 },
    scores: { 0: 0, 1: 0 },
    handNumber: 1,
    passesThisRound: 0,
  };
}

export function nextSeat(seat: Seat, alone: Seat | null): Seat {
  let n = ((seat + 1) % 4) as Seat;
  if (alone !== null && n === ((alone + 2) % 4)) {
    n = ((n + 1) % 4) as Seat;
  }
  return n;
}

export function applyPass(state: EuchreState): EuchreState {
  if (state.phase !== 'bid_round_1' && state.phase !== 'bid_round_2') {
    throw new Error('cannot pass outside bidding');
  }
  if (state.phase === 'bid_round_2' && state.current === state.dealer) {
    throw new Error('stick the dealer: dealer cannot pass in round 2');
  }
  const passes = state.passesThisRound + 1;
  if (state.phase === 'bid_round_1' && passes === 4) {
    return {
      ...state,
      phase: 'bid_round_2',
      upcardStatus: 'turned_down',
      current: ((state.dealer + 1) % 4) as Seat,
      passesThisRound: 0,
    };
  }
  return {
    ...state,
    current: ((state.current + 1) % 4) as Seat,
    passesThisRound: passes,
  };
}

export function applyOrderUp(state: EuchreState, alone: boolean): EuchreState {
  if (state.phase !== 'bid_round_1' || state.upcard === null) {
    throw new Error('order_up only valid in round 1');
  }
  const trump = state.upcard[1] as Suit;
  return {
    ...state,
    phase: 'discard',
    trump,
    maker: state.current,
    alone: alone ? state.current : null,
    upcardStatus: 'taken',
    current: state.dealer,
  };
}

export function applyDealerDiscard(state: EuchreState, discard: Card): EuchreState {
  if (state.phase !== 'discard' || state.upcard === null) {
    throw new Error('not in discard phase');
  }
  const dealerHand = state.hands[state.dealer];
  const withUpcard = [...dealerHand, state.upcard];
  if (!withUpcard.includes(discard)) {
    throw new Error('cannot discard card not held');
  }
  const newHand = withUpcard.filter((c) => c !== discard);
  return {
    ...state,
    hands: { ...state.hands, [state.dealer]: newHand },
    upcard: null,
    phase: 'play',
    current: nextSeat(state.dealer, state.alone),
  };
}

export function applyCallTrump(state: EuchreState, suit: Suit, alone: boolean): EuchreState {
  if (state.phase !== 'bid_round_2') throw new Error('call_trump only in round 2');
  if (state.upcard !== null && suit === (state.upcard[1] as Suit)) {
    throw new Error('cannot call trump matching turned-down upcard');
  }
  return {
    ...state,
    phase: 'play',
    trump: suit,
    maker: state.current,
    alone: alone ? state.current : null,
    current: nextSeat(state.dealer, alone ? state.current : null),
  };
}

export function applyPlayCard(state: EuchreState, card: Card): EuchreState {
  if (state.phase !== 'play' || state.trump === null) throw new Error('not in play phase');
  const seat = state.current;
  const hand = state.hands[seat];
  if (!hand.includes(card)) throw new Error('card not in hand');
  const legal = legalPlays(hand, state.ledCard, state.trump);
  if (!legal.includes(card)) throw new Error('illegal play (must follow suit)');

  const newHand = hand.filter((c) => c !== card);
  const trick = [...state.trick, { seat, card }];
  const ledCard = state.ledCard ?? card;
  const expectedPlays = state.alone !== null ? 3 : 4;

  if (trick.length < expectedPlays) {
    return {
      ...state,
      hands: { ...state.hands, [seat]: newHand },
      ledCard,
      trick,
      current: nextSeat(seat, state.alone),
    };
  }

  const winner = trickWinner(trick, state.trump) as Seat;
  const winningTeam = teamOf(winner);
  const tricksWon = { ...state.tricksWon, [winningTeam]: state.tricksWon[winningTeam] + 1 };
  const handsAfter = { ...state.hands, [seat]: newHand };
  const handDone = Object.values(handsAfter).every((h) => h.length === 0);

  if (!handDone) {
    return {
      ...state,
      hands: handsAfter,
      ledCard: null,
      trick: [],
      tricksWon,
      current: winner,
    };
  }

  return scoreHand({ ...state, hands: handsAfter, ledCard: null, trick: [], tricksWon, current: winner });
}

function scoreHand(state: EuchreState): EuchreState {
  if (state.maker === null) throw new Error('no maker on hand end');
  const makerTeam = teamOf(state.maker);
  const otherTeam = (1 - makerTeam) as Team;
  const makerTricks = state.tricksWon[makerTeam];
  let pointsTo: Team;
  let pointsAmount: number;

  if (makerTricks >= 3) {
    pointsTo = makerTeam;
    if (makerTricks === 5) pointsAmount = state.alone !== null ? 4 : 2;
    else pointsAmount = 1;
  } else {
    pointsTo = otherTeam;
    pointsAmount = 2;
  }

  const scores = { ...state.scores, [pointsTo]: state.scores[pointsTo] + pointsAmount };
  const gameOver = scores[0] >= 10 || scores[1] >= 10;
  if (gameOver) {
    return { ...state, scores, phase: 'game_complete' };
  }
  return { ...state, scores, phase: 'hand_complete' };
}

export function startNextHand(state: EuchreState, rand?: () => number): EuchreState {
  if (state.phase !== 'hand_complete') throw new Error('current hand not complete');
  const nextDealer = ((state.dealer + 1) % 4) as Seat;
  const dealt = dealHand(nextDealer, rand);
  return {
    ...dealt,
    scores: state.scores,
    handNumber: state.handNumber + 1,
  };
}

export function ledSuitOf(state: EuchreState): Suit | null {
  if (state.ledCard === null || state.trump === null) return null;
  return effectiveSuit(state.ledCard, state.trump);
}
