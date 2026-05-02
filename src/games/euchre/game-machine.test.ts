import { describe, it, expect } from 'vitest';
import type { Suit } from '../../lib/database.types';
import {
  applyCallTrump,
  applyOrderUp,
  applyPass,
  dealHand,
  type Seat,
} from './game-machine';

describe('dealing', () => {
  it('deals 5 cards to each player + 1 upcard', () => {
    const s = dealHand(0);
    for (let i = 0; i < 4; i++) {
      expect(s.hands[i as Seat]).toHaveLength(5);
    }
    expect(s.upcard).not.toBeNull();
    expect(s.phase).toBe('bid_round_1');
    expect(s.current).toBe(1);
  });

  it('all cards are unique', () => {
    const s = dealHand(0);
    const seen = new Set<string>();
    for (const c of [...s.hands[0], ...s.hands[1], ...s.hands[2], ...s.hands[3], s.upcard!]) {
      expect(seen.has(c)).toBe(false);
      seen.add(c);
    }
    expect(seen.size).toBe(21);
  });
});

describe('bidding', () => {
  it('four passes in round 1 advances to round 2 with upcard turned down', () => {
    let s = dealHand(0);
    for (let i = 0; i < 4; i++) s = applyPass(s);
    expect(s.phase).toBe('bid_round_2');
    expect(s.upcardStatus).toBe('turned_down');
    expect(s.current).toBe(1);
  });

  it('stick the dealer: dealer cannot pass in round 2', () => {
    let s = dealHand(0);
    for (let i = 0; i < 4; i++) s = applyPass(s);
    s = applyPass(s); // seat 1
    s = applyPass(s); // seat 2
    s = applyPass(s); // seat 3
    expect(s.current).toBe(0);
    expect(() => applyPass(s)).toThrow(/stick the dealer/i);
  });

  it('order up sets trump and goes to discard with dealer to act', () => {
    let s = dealHand(0);
    s = { ...s, upcard: 'AH', current: 1 };
    s = applyOrderUp(s, false);
    expect(s.phase).toBe('discard');
    expect(s.trump).toBe('H');
    expect(s.maker).toBe(1);
    expect(s.current).toBe(0);
  });

  it('round-2 call cannot match the turned-down suit', () => {
    let s = dealHand(0);
    for (let i = 0; i < 4; i++) s = applyPass(s);
    expect(() => applyCallTrump(s, s.upcard![1] as Suit, false)).toThrow();
  });
});
