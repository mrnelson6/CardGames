import { describe, it, expect } from 'vitest';
import type { Card } from '../../lib/database.types';
import {
  cardStrength,
  effectiveSuit,
  isLeftBower,
  isRightBower,
  legalPlays,
  trickWinner,
} from './cards';

describe('left-bower follows trump', () => {
  it('JD is the left bower when hearts are trump', () => {
    expect(isLeftBower('JD', 'H')).toBe(true);
    expect(isRightBower('JH', 'H')).toBe(true);
    expect(effectiveSuit('JD', 'H')).toBe('H');
  });

  it('player holding JD must follow when hearts are led, even though JD is a diamond', () => {
    const hand: Card[] = ['JD', '9C', 'TC', 'KC', 'AS'];
    expect(legalPlays(hand, '9H', 'H')).toEqual(['JD']);
  });

  it('right bower beats left bower beats other trump', () => {
    expect(cardStrength('JH', 'H', 'H')).toBeGreaterThan(cardStrength('JD', 'H', 'H'));
    expect(cardStrength('JD', 'H', 'H')).toBeGreaterThan(cardStrength('AH', 'H', 'H'));
  });
});

describe('trick winner', () => {
  it('highest trump wins when trump played', () => {
    const plays: Array<{ seat: number; card: Card }> = [
      { seat: 0, card: '9S' },
      { seat: 1, card: 'AS' },
      { seat: 2, card: 'KS' },
      { seat: 3, card: '9H' },
    ];
    expect(trickWinner(plays, 'H')).toBe(3);
  });

  it('left bower beats off-suit ace led', () => {
    const plays: Array<{ seat: number; card: Card }> = [
      { seat: 0, card: 'AS' },
      { seat: 1, card: '9S' },
      { seat: 2, card: 'JC' },
      { seat: 3, card: '9D' },
    ];
    expect(trickWinner(plays, 'C')).toBe(2);
  });

  it('highest of led suit wins when no trump played', () => {
    const plays: Array<{ seat: number; card: Card }> = [
      { seat: 0, card: '9D' },
      { seat: 1, card: 'AD' },
      { seat: 2, card: 'KS' },
      { seat: 3, card: 'TD' },
    ];
    expect(trickWinner(plays, 'H')).toBe(1);
  });
});

describe('legal plays', () => {
  it('no requirement to follow when leading', () => {
    const hand: Card[] = ['9C', 'AH'];
    expect(legalPlays(hand, null, 'S')).toEqual(['9C', 'AH']);
  });

  it('must follow led suit if able', () => {
    const hand: Card[] = ['9C', 'AH'];
    expect(legalPlays(hand, '9H', 'S')).toEqual(['AH']);
  });

  it('any card legal when void', () => {
    const hand: Card[] = ['9C', 'TC'];
    expect(legalPlays(hand, '9H', 'S')).toEqual(['9C', 'TC']);
  });
});
