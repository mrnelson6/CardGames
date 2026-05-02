// DB-fetch helpers + state mutations for Euchre.
// All writes go through the service-role admin client (bypasses RLS).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  type Card,
  type Seat,
  type Suit,
  type Team,
  dealEuchre,
  effectiveSuit,
  legalPlays,
  nextSeat,
  scoreHandResult,
  teamOf,
  trickWinner,
} from './euchre.ts';

export const TURN_SECONDS = 45;

export interface FullGame {
  id: string;
  status: 'lobby' | 'playing' | 'finished' | 'abandoned';
  game: string;
  mode: string | null;
  current_seat: number | null;
  team0_score: number;
  team1_score: number;
  turn_deadline: string | null;
  invite_code: string | null;
}

export interface EuchreRow {
  game_id: string;
  dealer_seat: number;
  hand_number: number;
  current_trick_id: string | null;
  trump_suit: Suit | null;
  maker_seat: number | null;
  alone_seat: number | null;
  upcard: Card | null;
  upcard_status: 'face_up' | 'turned_down' | 'taken' | null;
}

export interface PlayerRow {
  game_id: string;
  seat: number;
  user_id: string | null;
  is_bot: boolean;
  missed_turns: number;
}

export interface HandRow {
  game_id: string;
  seat: number;
  user_id: string | null;
  cards: Card[];
  discarded_card: Card | null;
}

export interface TrickRow {
  id: string;
  game_id: string;
  hand_number: number;
  trick_number: number;
  lead_seat: number;
  winner_seat: number | null;
  led_suit: string | null;
}

export interface TrickPlayRow {
  trick_id: string;
  seat: number;
  card: Card;
}

export async function loadGame(admin: SupabaseClient, gameId: string): Promise<FullGame | null> {
  const { data, error } = await admin.from('games').select('*').eq('id', gameId).maybeSingle();
  if (error) throw new Error(`loadGame: ${error.message}`);
  return data as FullGame | null;
}

export async function loadEuchreState(
  admin: SupabaseClient,
  gameId: string,
): Promise<EuchreRow | null> {
  const { data, error } = await admin
    .from('euchre_games')
    .select('*')
    .eq('game_id', gameId)
    .maybeSingle();
  if (error) throw new Error(`loadEuchreState: ${error.message}`);
  return data as EuchreRow | null;
}

export async function loadPlayers(admin: SupabaseClient, gameId: string): Promise<PlayerRow[]> {
  const { data, error } = await admin
    .from('game_players')
    .select('*')
    .eq('game_id', gameId)
    .order('seat');
  if (error) throw new Error(`loadPlayers: ${error.message}`);
  return (data ?? []) as PlayerRow[];
}

export async function loadHands(admin: SupabaseClient, gameId: string): Promise<HandRow[]> {
  const { data, error } = await admin.from('game_hands').select('*').eq('game_id', gameId);
  if (error) throw new Error(`loadHands: ${error.message}`);
  return (data ?? []) as HandRow[];
}

export async function loadCurrentTrick(
  admin: SupabaseClient,
  trickId: string | null,
): Promise<{ trick: TrickRow | null; plays: TrickPlayRow[] }> {
  if (!trickId) return { trick: null, plays: [] };
  const [{ data: trick, error: tErr }, { data: plays, error: pErr }] = await Promise.all([
    admin.from('tricks').select('*').eq('id', trickId).maybeSingle(),
    admin.from('trick_plays').select('*').eq('trick_id', trickId).order('played_at'),
  ]);
  if (tErr) throw new Error(`loadCurrentTrick: ${tErr.message}`);
  if (pErr) throw new Error(`loadCurrentTrick plays: ${pErr.message}`);
  return { trick: trick as TrickRow | null, plays: (plays ?? []) as TrickPlayRow[] };
}

export function inSeat(players: PlayerRow[], userId: string): PlayerRow | null {
  return players.find((p) => p.user_id === userId) ?? null;
}

export function deadlineNowPlus(secs: number = TURN_SECONDS): string {
  return new Date(Date.now() + secs * 1000).toISOString();
}

export interface DealOutput {
  hands: HandRow[];          // shaped for upsert into game_hands
  euchre: Partial<EuchreRow>; // dealer/upcard/etc.
  current_seat: number;
  turn_deadline: string;
}

export function buildDealForHand(
  gameId: string,
  players: PlayerRow[],
  dealer: Seat,
  handNumber: number,
): DealOutput {
  const { hands, upcard } = dealEuchre();
  const handsRows: HandRow[] = players.map((p) => ({
    game_id: gameId,
    seat: p.seat,
    user_id: p.user_id, // null for bots — RLS hides bot hands from humans
    cards: hands[p.seat as Seat],
    discarded_card: null,
  }));
  const firstSeat = ((dealer + 1) % 4) as Seat;
  return {
    hands: handsRows,
    euchre: {
      game_id: gameId,
      dealer_seat: dealer,
      hand_number: handNumber,
      trump_suit: null,
      maker_seat: null,
      alone_seat: null,
      upcard,
      upcard_status: 'face_up',
      current_trick_id: null,
    },
    current_seat: firstSeat,
    turn_deadline: deadlineNowPlus(),
  };
}

// Re-exports for handler use.
export { effectiveSuit, legalPlays, nextSeat, scoreHandResult, teamOf, trickWinner };
