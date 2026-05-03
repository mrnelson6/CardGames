// POST /functions/v1/start-party-bot-game
// Body: { turn_seconds?: number | null, randomize?: boolean }
// Leader-only. Spawns an unranked Euchre game with both party members
// on the same team (seats 0 + 2) and bots filling the opposing team.
// Optional `randomize` shuffles the seat assignment before deal.
// Disbands the party so it can't be reused for a different start.
// Returns { game_id }.

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
  type PlayerRow,
} from '../_shared/games/euchre/state.ts';
import { autoAdvanceBots } from '../_shared/games/euchre/auto_advance.ts';
import { type Seat } from '../_shared/games/euchre/euchre.ts';

interface Body {
  turn_seconds?: number | null;
  randomize?: boolean;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;

  let effectiveTurnSeconds: number | null = 45;
  if (Object.prototype.hasOwnProperty.call(body, 'turn_seconds')) {
    effectiveTurnSeconds = body.turn_seconds ?? null;
    if (typeof effectiveTurnSeconds === 'number' && effectiveTurnSeconds <= 0) {
      return fail(400, 'bad_turn_seconds', 'turn_seconds must be > 0 or null');
    }
  }

  const admin = adminClient();

  // Caller must be the party leader.
  const { data: party, error: pErr } = await admin
    .from('parties')
    .select('id, leader_id')
    .eq('leader_id', user.id)
    .maybeSingle();
  if (pErr) return fail(500, 'db_party', pErr.message);
  if (!party) return fail(409, 'no_party', 'You are not leading a party');

  const { data: members } = await admin
    .from('party_members')
    .select('user_id')
    .eq('party_id', party.id);
  const memberIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (memberIds.length !== 2) {
    return fail(409, 'not_full', `Party needs 2 members (has ${memberIds.length})`);
  }
  const partner = memberIds.find((id) => id !== user.id);
  if (!partner) return fail(500, 'bad_state', 'Could not identify partner');

  // Build the four players. Leader at seat 0, partner at seat 2 so they're
  // teammates. Bots at 1 and 3.
  const seats: Array<{ user_id: string | null; is_bot: boolean }> = [
    { user_id: user.id, is_bot: false },
    { user_id: null,    is_bot: true  },
    { user_id: partner, is_bot: false },
    { user_id: null,    is_bot: true  },
  ];
  if (body.randomize) {
    // Shuffle in place (Fisher–Yates).
    for (let i = seats.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [seats[i], seats[j]] = [seats[j], seats[i]];
    }
  }

  const { data: gRow, error: gErr } = await admin
    .from('games')
    .insert({
      game: 'euchre',
      status: 'playing',
      team0_score: 0,
      team1_score: 0,
      turn_seconds: effectiveTurnSeconds,
      // No leader_id (this isn't a private-room lobby), no mode (unranked),
      // no invite_code.
    })
    .select('id')
    .single();
  if (gErr) return fail(500, 'db_create_game', gErr.message);
  const gameId = gRow.id;

  const dealerSeat = Math.floor(Math.random() * 4);
  const { error: euErr } = await admin.from('euchre_games').insert({
    game_id: gameId,
    dealer_seat: dealerSeat,
    hand_number: 0,
  });
  if (euErr) {
    await admin.from('games').delete().eq('id', gameId);
    return fail(500, 'db_create_euchre', euErr.message);
  }

  const players: PlayerRow[] = seats.map((s, idx) => ({
    game_id: gameId,
    seat: idx,
    user_id: s.user_id,
    is_bot: s.is_bot,
    missed_turns: 0,
  }));
  const { error: insErr } = await admin.from('game_players').insert(players);
  if (insErr) {
    await admin.from('games').delete().eq('id', gameId);
    return fail(500, 'db_seat_players', insErr.message);
  }

  const deal = buildDealForHand(gameId, players, dealerSeat as Seat, 1, effectiveTurnSeconds);
  const { error: hErr } = await admin.from('game_hands').upsert(deal.hands);
  if (hErr) return fail(500, 'db_deal_hands', hErr.message);

  const { error: euUpdErr } = await admin
    .from('euchre_games')
    .update({
      hand_number: 1,
      upcard: deal.euchre.upcard,
      upcard_status: deal.euchre.upcard_status,
    })
    .eq('game_id', gameId);
  if (euUpdErr) return fail(500, 'db_eu_update', euUpdErr.message);

  const { error: gUpdErr } = await admin
    .from('games')
    .update({
      current_seat: deal.current_seat,
      turn_deadline: deal.turn_deadline,
    })
    .eq('id', gameId);
  if (gUpdErr) return fail(500, 'db_game_update', gUpdErr.message);

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: dealerSeat,
    action_type: 'start_party_bot_game',
    payload: { party_id: party.id, leader: user.id, partner, randomized: !!body.randomize },
  });

  // Disband the party — the game is the new context.
  await admin.from('mm_queue').delete().eq('party_id', party.id);
  await admin.from('parties').delete().eq('id', party.id);

  await autoAdvanceBots(admin, gameId);

  return json({ game_id: gameId });
});
