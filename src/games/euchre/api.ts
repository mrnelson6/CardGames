import type { Card, Suit } from '../../lib/database.types';
import { supabase } from '../../lib/supabase';

interface ApiError {
  error: { code: string; message: string };
}

async function invoke<T>(fn: string, body: object): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T | ApiError>(fn, { body });
  if (error) {
    const ctx = (data as ApiError | null)?.error;
    throw new Error(ctx ? `${ctx.code}: ${ctx.message}` : error.message);
  }
  if (data && typeof data === 'object' && 'error' in (data as object)) {
    const ctx = (data as ApiError).error;
    throw new Error(`${ctx.code}: ${ctx.message}`);
  }
  return data as T;
}

export interface CreateRoomResult {
  game_id: string;
  invite_code: string;
  seat: number;
}
export interface JoinRoomResult {
  game_id: string;
  invite_code: string;
  seat: number;
  status: string;
}

export const euchreApi = {
  createRoom: () => invoke<CreateRoomResult>('create-euchre-room', {}),
  joinRoom: (invite_code: string, seat?: number) =>
    invoke<JoinRoomResult>('join-euchre-room', seat === undefined ? { invite_code } : { invite_code, seat }),
  pass: (game_id: string) =>
    invoke<{ ok: true }>('euchre-bid-action', { game_id, action: 'pass' }),
  orderUp: (game_id: string, alone: boolean) =>
    invoke<{ ok: true }>('euchre-bid-action', { game_id, action: 'order_up', alone }),
  callTrump: (game_id: string, suit: Suit, alone: boolean) =>
    invoke<{ ok: true }>('euchre-bid-action', { game_id, action: 'call_trump', suit, alone }),
  discard: (game_id: string, card: Card) =>
    invoke<{ ok: true }>('euchre-discard', { game_id, card }),
  playCard: (game_id: string, card: Card) =>
    invoke<{ ok: true }>('euchre-play-card', { game_id, card }),
  enforceTimeout: (game_id: string, expected_seat: number, expected_deadline: string) =>
    invoke<{ ok: true; acted: boolean; reason?: string }>('enforce-timeout', {
      game_id,
      expected_seat,
      expected_deadline,
    }),
  enqueueMatchmaking: (mode: 'solo' | 'duo') =>
    invoke<{ ok: true; rating?: number; party_id?: string; band: number }>('enqueue-mm', {
      game: 'euchre',
      mode,
    }),
  createParty: () =>
    invoke<{ party_id: string; invite_code: string; leader_id: string; already_in_party?: boolean }>(
      'create-party',
      {},
    ),
  joinParty: (invite_code: string) =>
    invoke<{ party_id: string; invite_code: string; leader_id?: string; already_member?: boolean }>(
      'join-party',
      { invite_code },
    ),
  leaveParty: () =>
    invoke<{ ok: true; was_in_party?: boolean; disbanded?: boolean }>('leave-party', {}),
  inviteToParty: (to_user: string) =>
    invoke<{ ok: true; party_id: string; invite_id?: string; already_member?: boolean }>(
      'invite-to-party',
      { to_user },
    ),
  acceptPartyInvite: (invite_id: string) =>
    invoke<{ party_id: string; invite_code: string; already_member?: boolean }>(
      'accept-party-invite',
      { invite_id },
    ),
  declineInvite: (kind: 'game' | 'party', invite_id: string) =>
    invoke<{ ok: true; already_gone?: boolean }>('decline-invite', { kind, invite_id }),
  resumeControl: (game_id: string) =>
    invoke<{ ok: true; was_bot: boolean }>('resume-control', { game_id }),
  createBotGame: () => invoke<{ game_id: string }>('create-bot-game', {}),
  inviteFriendToGame: (to_user: string) =>
    invoke<{ game_id: string; invite_code: string; invite_id: string }>(
      'invite-friend-to-game',
      { to_user },
    ),
  acceptGameInvite: (invite_id: string) =>
    invoke<{ game_id: string; invite_code: string; seat: number | null; status: string }>(
      'accept-game-invite',
      { invite_id },
    ),
  roomAddBot: (game_id: string, seat: number) =>
    invoke<{ ok: true }>('euchre-room-action', { game_id, op: 'add_bot', seat }),
  roomRemoveSeat: (game_id: string, seat: number) =>
    invoke<{ ok: true }>('euchre-room-action', { game_id, op: 'remove_seat', seat }),
  roomSwapSeats: (game_id: string, seat_a: number, seat_b: number) =>
    invoke<{ ok: true }>('euchre-room-action', { game_id, op: 'swap_seats', seat_a, seat_b }),
  roomStart: (
    game_id: string,
    opts?: {
      randomize?: boolean;
      fill_bots?: boolean;
      /** seconds per turn; null = no time limit; omit to keep the room's default */
      turn_seconds?: number | null;
    },
  ) =>
    invoke<{ ok: true; status: string }>(
      'euchre-room-action',
      opts && Object.prototype.hasOwnProperty.call(opts, 'turn_seconds')
        ? {
            game_id, op: 'start',
            randomize: opts?.randomize ?? false,
            fill_bots: opts?.fill_bots ?? false,
            turn_seconds: opts.turn_seconds ?? null,
          }
        : {
            game_id, op: 'start',
            randomize: opts?.randomize ?? false,
            fill_bots: opts?.fill_bots ?? false,
          },
    ),
};
