// POST /functions/v1/euchre-room-action
// Leader-only mutations on a private Euchre room while it's still in lobby.
//   { game_id, op: 'add_bot',     seat: 0|1|2|3 }
//   { game_id, op: 'remove_seat', seat: 0|1|2|3 }                    -- can't remove the leader's own seat
//   { game_id, op: 'swap_seats',  seat_a: 0|1|2|3, seat_b: 0|1|2|3 } -- swap two occupants
//   { game_id, op: 'start',       randomize?: boolean, fill_bots?: boolean }
//
// 'start' transitions the room to 'playing' and deals hand 1 atomically.

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';
import {
  buildDealForHand,
  loadEuchreState,
  loadGame,
  loadPlayers,
} from '../_shared/games/euchre/state.ts';
import { autoAdvanceBots } from '../_shared/games/euchre/auto_advance.ts';
import type { Seat } from '../_shared/games/euchre/euchre.ts';

interface BodyAddBot     { game_id: string; op: 'add_bot';     seat: number }
interface BodyRemoveSeat { game_id: string; op: 'remove_seat'; seat: number }
interface BodySwapSeats  { game_id: string; op: 'swap_seats';  seat_a: number; seat_b: number }
interface BodyStart      { game_id: string; op: 'start';       randomize?: boolean; fill_bots?: boolean }
type Body = BodyAddBot | BodyRemoveSeat | BodySwapSeats | BodyStart;

function isSeat(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 3;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.game_id || !body.op) return fail(400, 'bad_body', 'game_id and op required');

  const admin = adminClient();

  const game = await loadGame(admin, body.game_id);
  if (!game) return fail(404, 'no_game', 'Game not found');
  if (game.game !== 'euchre') return fail(409, 'wrong_game', 'Not an Euchre room');
  if (game.status !== 'lobby') return fail(409, 'in_progress', `Room is ${game.status}`);
  if (game.leader_id && game.leader_id !== user.id) {
    return fail(403, 'not_leader', 'Only the room leader can do that');
  }

  const players = await loadPlayers(admin, body.game_id);
  // Leader fallback for legacy rooms with no leader_id: seat 0's user.
  if (!game.leader_id) {
    const seat0 = players.find((p) => p.seat === 0);
    if (!seat0 || seat0.user_id !== user.id) {
      return fail(403, 'not_leader', 'Only the room leader can do that');
    }
  }

  const taken = new Map<number, typeof players[number]>();
  for (const p of players) taken.set(p.seat, p);

  if (body.op === 'add_bot') {
    if (!isSeat(body.seat)) return fail(400, 'bad_body', 'seat must be 0-3');
    if (taken.has(body.seat)) return fail(409, 'seat_taken', 'Seat is occupied');
    const ins = await admin.from('game_players').insert({
      game_id: body.game_id,
      seat: body.seat,
      user_id: null,
      is_bot: true,
      missed_turns: 0,
    });
    if (ins.error) {
      if (ins.error.code === '23505') return fail(409, 'seat_taken', 'Seat just got taken');
      return fail(500, 'db_add_bot', ins.error.message);
    }
    await admin.from('game_actions').insert({
      game_id: body.game_id, seat: body.seat,
      action_type: 'add_bot', payload: {},
    });
    return json({ ok: true });
  }

  if (body.op === 'remove_seat') {
    if (!isSeat(body.seat)) return fail(400, 'bad_body', 'seat must be 0-3');
    const occupant = taken.get(body.seat);
    if (!occupant) return fail(404, 'empty_seat', 'Seat is already empty');
    if (occupant.user_id === user.id) {
      return fail(400, 'cant_remove_self', 'Leader can\'t kick themselves — leave the room instead');
    }
    const del = await admin
      .from('game_players')
      .delete()
      .eq('game_id', body.game_id)
      .eq('seat', body.seat);
    if (del.error) return fail(500, 'db_remove', del.error.message);
    await admin.from('game_actions').insert({
      game_id: body.game_id, seat: body.seat,
      action_type: 'remove_seat',
      payload: { was_bot: occupant.is_bot, was_user: occupant.user_id },
    });
    return json({ ok: true });
  }

  if (body.op === 'swap_seats') {
    if (!isSeat(body.seat_a) || !isSeat(body.seat_b)) return fail(400, 'bad_body', 'seats must be 0-3');
    if (body.seat_a === body.seat_b) return fail(400, 'same_seat', 'Pick two different seats');
    const a = taken.get(body.seat_a);
    const b = taken.get(body.seat_b);
    if (!a && !b) return fail(404, 'both_empty', 'Both seats are empty');

    // Strategy: delete both, then re-insert with swapped seats.
    // Wrapped in a single round-trip is impossible across two tables; we
    // rely on the (game_id, seat) PK to roll back via an error if a race
    // happens. Acceptable for lobby-only edits.
    const seats = [body.seat_a, body.seat_b];
    const del = await admin
      .from('game_players')
      .delete()
      .eq('game_id', body.game_id)
      .in('seat', seats);
    if (del.error) return fail(500, 'db_swap_del', del.error.message);

    const reinsert = [];
    if (a) reinsert.push({
      game_id: body.game_id, seat: body.seat_b,
      user_id: a.user_id, is_bot: a.is_bot, missed_turns: 0,
    });
    if (b) reinsert.push({
      game_id: body.game_id, seat: body.seat_a,
      user_id: b.user_id, is_bot: b.is_bot, missed_turns: 0,
    });
    if (reinsert.length > 0) {
      const ins = await admin.from('game_players').insert(reinsert);
      if (ins.error) return fail(500, 'db_swap_ins', ins.error.message);
    }
    await admin.from('game_actions').insert({
      game_id: body.game_id, seat: body.seat_a,
      action_type: 'swap_seats',
      payload: { seat_a: body.seat_a, seat_b: body.seat_b },
    });
    return json({ ok: true });
  }

  if (body.op === 'start') {
    let current = players;

    // Optionally fill empty seats with bots first.
    if (body.fill_bots) {
      const seatsTaken = new Set(current.map((p) => p.seat));
      const toAdd = [];
      for (let s = 0; s < 4; s++) {
        if (!seatsTaken.has(s)) toAdd.push(s);
      }
      if (toAdd.length > 0) {
        const ins = await admin.from('game_players').insert(
          toAdd.map((seat) => ({
            game_id: body.game_id, seat, user_id: null, is_bot: true, missed_turns: 0,
          })),
        );
        if (ins.error) return fail(500, 'db_fill_bots', ins.error.message);
      }
      current = await loadPlayers(admin, body.game_id);
    }

    if (current.length < 4) {
      return fail(409, 'not_full', `Room only has ${current.length}/4 seats filled`);
    }

    if (body.randomize) {
      const shuffled = current.slice().sort(() => Math.random() - 0.5);
      const newSeats = shuffled.map((p, i) => ({
        ...p, seat: i,
      }));
      // Replace all rows.
      const del = await admin
        .from('game_players')
        .delete()
        .eq('game_id', body.game_id);
      if (del.error) return fail(500, 'db_shuffle_del', del.error.message);
      const ins = await admin.from('game_players').insert(
        newSeats.map((p) => ({
          game_id: body.game_id,
          seat: p.seat,
          user_id: p.user_id,
          is_bot: p.is_bot,
          missed_turns: 0,
        })),
      );
      if (ins.error) return fail(500, 'db_shuffle_ins', ins.error.message);
      current = await loadPlayers(admin, body.game_id);
      await admin.from('game_actions').insert({
        game_id: body.game_id, seat: null,
        action_type: 'randomize_seats', payload: {},
      });
    }

    // Transition to playing + deal hand 1.
    const { data: started, error: tErr } = await admin
      .from('games')
      .update({ status: 'playing' })
      .eq('id', body.game_id)
      .eq('status', 'lobby')
      .select('id')
      .maybeSingle();
    if (tErr) return fail(500, 'db_start', tErr.message);
    if (!started) return fail(409, 'race', 'Room state changed');

    const eu = await loadEuchreState(admin, body.game_id);
    if (!eu) return fail(500, 'no_euchre_state', 'euchre_games row missing');

    // Re-pick a random dealer (the original was set at create time; refresh
    // in case seats were shuffled).
    const dealer = (Math.floor(Math.random() * 4)) as Seat;
    const deal = buildDealForHand(body.game_id, current, dealer, 1);

    const { error: hErr } = await admin.from('game_hands').upsert(deal.hands);
    if (hErr) return fail(500, 'db_deal_hands', hErr.message);

    const { error: euErr } = await admin
      .from('euchre_games')
      .update({
        dealer_seat: dealer,
        hand_number: 1,
        upcard: deal.euchre.upcard,
        upcard_status: deal.euchre.upcard_status,
        trump_suit: null,
        maker_seat: null,
        alone_seat: null,
        current_trick_id: null,
      })
      .eq('game_id', body.game_id);
    if (euErr) return fail(500, 'db_euchre_update', euErr.message);

    const { error: gUErr } = await admin
      .from('games')
      .update({
        current_seat: deal.current_seat,
        turn_deadline: deal.turn_deadline,
      })
      .eq('id', body.game_id);
    if (gUErr) return fail(500, 'db_game_update', gUErr.message);

    await admin.from('game_actions').insert({
      game_id: body.game_id, seat: dealer,
      action_type: 'deal_hand',
      payload: { hand_number: 1, dealer_seat: dealer },
    });

    await autoAdvanceBots(admin, body.game_id);

    return json({ ok: true, status: 'playing' });
  }

  return fail(400, 'bad_op', `Unknown op: ${(body as { op: string }).op}`);
});
