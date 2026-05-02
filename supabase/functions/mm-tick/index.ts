// POST /functions/v1/mm-tick
// Service-role only. Called by pg_cron every ~3s.
// For each (game, mode) pair, expands wait-time bands, picks a mutually-
// overlapping foursome (longest-wait greedy), balances teams highest+lowest
// vs middle two, atomically removes them from mm_queue, and creates a fresh
// playing game with hand 1 dealt.

import { adminClient, fail, json, preflight } from '../_shared/http.ts';
import { type Seat } from '../_shared/games/euchre/euchre.ts';
import {
  buildDealForHand,
  type PlayerRow,
} from '../_shared/games/euchre/state.ts';

interface QueueEntry {
  user_id: string;
  game: string;
  mode: string;
  party_id: string | null;
  party_size: number;
  rating: number;
  party_avg_rating: number;
  band: number;
  enqueued_at: string;
}

const BAND_BASE = 50;
const BAND_STEP = 25;
const BAND_STEP_SECONDS = 10;
const BAND_CAP = 300;
const MAX_PAIRS_PER_TICK = 20;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const auth = req.headers.get('Authorization') ?? '';
  const expectedKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!auth.endsWith(expectedKey) || expectedKey.length === 0) {
    return fail(401, 'no_auth', 'Service-role bearer required');
  }

  const admin = adminClient();

  const { data: rows, error: qErr } = await admin
    .from('mm_queue')
    .select('user_id, game, mode, party_id, party_size, rating, party_avg_rating, band, enqueued_at')
    .order('enqueued_at');
  if (qErr) return fail(500, 'db_scan', qErr.message);

  // Group by (game, mode).
  const groups = new Map<string, QueueEntry[]>();
  for (const r of (rows ?? []) as QueueEntry[]) {
    const k = `${r.game}:${r.mode}`;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  const created: string[] = [];

  for (const [key, group] of groups.entries()) {
    const [game, mode] = key.split(':');
    if (game !== 'euchre') continue;

    // Expand bands by wait time.
    const now = Date.now();
    for (const e of group) {
      const waited = (now - new Date(e.enqueued_at).getTime()) / 1000;
      const computed = Math.min(BAND_CAP, BAND_BASE + BAND_STEP * Math.floor(waited / BAND_STEP_SECONDS));
      e.band = Math.max(e.band, computed);
    }

    if (mode === 'solo') {
      let pairsThisTick = 0;
      while (group.length >= 4 && pairsThisTick < MAX_PAIRS_PER_TICK) {
        const four = pickFour(group);
        if (!four) break;
        const ok = await pairFourSolo(admin, game, mode, four);
        if (ok) {
          created.push(ok);
          for (const u of four) {
            const idx = group.findIndex((g) => g.user_id === u.user_id);
            if (idx !== -1) group.splice(idx, 1);
          }
          pairsThisTick += 1;
        } else { break; }
      }
    } else if (mode === 'duo') {
      // Group party rows: party is ready when both members' rows are present.
      const partyMap = new Map<string, QueueEntry[]>();
      for (const e of group) {
        if (!e.party_id) continue;
        const arr = partyMap.get(e.party_id);
        if (arr) arr.push(e);
        else partyMap.set(e.party_id, [e]);
      }
      const readyParties: Array<{
        party_id: string;
        members: QueueEntry[];
        avg: number;
        band: number;
        oldest: string;
      }> = [];
      for (const [pid, members] of partyMap.entries()) {
        if (members.length === 2) {
          readyParties.push({
            party_id: pid,
            members,
            avg: members[0].party_avg_rating,
            band: Math.max(members[0].band, members[1].band),
            oldest: members
              .map((m) => m.enqueued_at)
              .sort()[0],
          });
        }
      }
      readyParties.sort((a, b) => a.oldest.localeCompare(b.oldest));

      let pairsThisTick = 0;
      while (readyParties.length >= 2 && pairsThisTick < MAX_PAIRS_PER_TICK) {
        const seedIdx = 0;
        const seed = readyParties[seedIdx];
        const partnerIdx = readyParties.findIndex(
          (p, i) => i !== seedIdx && Math.abs(p.avg - seed.avg) <= Math.max(p.band, seed.band),
        );
        if (partnerIdx === -1) break;
        const partner = readyParties[partnerIdx];

        const ok = await pairTwoParties(admin, game, mode, seed.members, partner.members);
        if (ok) {
          created.push(ok);
          // Remove both parties — careful with index order.
          readyParties.splice(Math.max(seedIdx, partnerIdx), 1);
          readyParties.splice(Math.min(seedIdx, partnerIdx), 1);
          pairsThisTick += 1;
        } else { break; }
      }
    }
  }

  return json({ ok: true, created });
});

// Pick 4 mutually-overlapping queue entries, prioritizing the longest waiter.
function pickFour(group: QueueEntry[]): QueueEntry[] | null {
  for (const seed of group) {
    const inRangeOfSeed = group.filter((e) => Math.abs(e.rating - seed.rating) <= Math.max(seed.band, e.band));
    if (inRangeOfSeed.length < 4) continue;
    // Sort by wait (oldest first), then take 4 that mutually overlap with each other.
    const sorted = inRangeOfSeed.slice().sort(
      (a, b) => new Date(a.enqueued_at).getTime() - new Date(b.enqueued_at).getTime(),
    );
    for (const cand of combos4(sorted)) {
      if (mutuallyOverlap(cand)) return cand;
    }
  }
  return null;
}

// Yield up to a few combinations greedily. We don't want N choose 4, so we
// take the 8 longest-waiting candidates and try all 70 = C(8,4) — bounded.
function* combos4<T>(arr: T[]): Generator<T[]> {
  const pool = arr.slice(0, 8);
  for (let i = 0; i < pool.length - 3; i++) {
    for (let j = i + 1; j < pool.length - 2; j++) {
      for (let k = j + 1; k < pool.length - 1; k++) {
        for (let l = k + 1; l < pool.length; l++) {
          yield [pool[i], pool[j], pool[k], pool[l]];
        }
      }
    }
  }
}

function mutuallyOverlap(four: QueueEntry[]): boolean {
  for (let i = 0; i < four.length; i++) {
    for (let j = i + 1; j < four.length; j++) {
      const a = four[i], b = four[j];
      if (Math.abs(a.rating - b.rating) > Math.max(a.band, b.band)) return false;
    }
  }
  return true;
}

async function pairFourSolo(
  admin: ReturnType<typeof adminClient>,
  game: string,
  mode: string,
  four: QueueEntry[],
): Promise<string | null> {
  // Atomically delete the 4 from mm_queue. If anyone left the queue between
  // our scan and now, abort this pairing — they'll show up next tick.
  const ids = four.map((e) => e.user_id);
  const { data: removed, error: rErr } = await admin
    .from('mm_queue')
    .delete()
    .in('user_id', ids)
    .select('user_id');
  if (rErr) {
    console.error('mm-tick delete failed', rErr);
    return null;
  }
  if (!removed || removed.length < 4) {
    // Race lost — re-insert what we got out and bail.
    if (removed && removed.length > 0) {
      // Best-effort restore: re-fetch the original entries' state from `four`.
      const survivors = four.filter((e) => removed.find((r) => r.user_id === e.user_id));
      if (survivors.length > 0) {
        await admin.from('mm_queue').insert(
          survivors.map((s) => ({
            user_id: s.user_id, game: s.game, mode: s.mode,
            party_id: null, party_size: 1, rating: s.rating,
            party_avg_rating: s.rating, band: s.band, enqueued_at: s.enqueued_at,
          })),
        );
      }
    }
    return null;
  }

  // Balance teams: sort by rating ascending; team A = lowest+highest, team B = middle two.
  const sorted = four.slice().sort((a, b) => a.rating - b.rating);
  // seat 0/2 = team 0 ; seat 1/3 = team 1
  const seat0 = sorted[3]; // highest
  const seat2 = sorted[0]; // lowest (partner of highest, balancing team avg)
  const seat1 = sorted[2];
  const seat3 = sorted[1];

  // Pick a random dealer.
  const dealerSeat = Math.floor(Math.random() * 4);

  // Create games row.
  const { data: gRow, error: gErr } = await admin
    .from('games')
    .insert({
      game,
      mode,
      status: 'playing',
      team0_score: 0,
      team1_score: 0,
    })
    .select('id')
    .single();
  if (gErr) {
    console.error('mm-tick game insert failed', gErr);
    // Restore queue entries.
    await admin.from('mm_queue').insert(four.map((s) => ({
      user_id: s.user_id, game: s.game, mode: s.mode,
      party_id: null, party_size: 1, rating: s.rating,
      party_avg_rating: s.rating, band: s.band, enqueued_at: s.enqueued_at,
    })));
    return null;
  }
  const gameId = gRow.id;

  await admin.from('euchre_games').insert({
    game_id: gameId,
    dealer_seat: dealerSeat,
    hand_number: 0,
  });

  const playerRows: PlayerRow[] = [
    { game_id: gameId, seat: 0, user_id: seat0.user_id, is_bot: false, missed_turns: 0 },
    { game_id: gameId, seat: 1, user_id: seat1.user_id, is_bot: false, missed_turns: 0 },
    { game_id: gameId, seat: 2, user_id: seat2.user_id, is_bot: false, missed_turns: 0 },
    { game_id: gameId, seat: 3, user_id: seat3.user_id, is_bot: false, missed_turns: 0 },
  ];
  await admin.from('game_players').insert(playerRows);

  // Deal hand 1.
  const deal = buildDealForHand(gameId, playerRows, dealerSeat as Seat, 1);
  await admin.from('game_hands').upsert(deal.hands);
  await admin
    .from('euchre_games')
    .update({
      hand_number: 1,
      upcard: deal.euchre.upcard,
      upcard_status: deal.euchre.upcard_status,
    })
    .eq('game_id', gameId);
  await admin
    .from('games')
    .update({ current_seat: deal.current_seat, turn_deadline: deal.turn_deadline })
    .eq('id', gameId);

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: dealerSeat,
    action_type: 'matchmade',
    payload: {
      mode,
      team0: [seat0.user_id, seat2.user_id],
      team1: [seat1.user_id, seat3.user_id],
      avg_rating_t0: Math.round((seat0.rating + seat2.rating) / 2),
      avg_rating_t1: Math.round((seat1.rating + seat3.rating) / 2),
    },
  });

  return gameId;
}

async function pairTwoParties(
  admin: ReturnType<typeof adminClient>,
  game: string,
  mode: string,
  partyA: QueueEntry[],
  partyB: QueueEntry[],
): Promise<string | null> {
  const ids = [...partyA, ...partyB].map((e) => e.user_id);
  const { data: removed, error: rErr } = await admin
    .from('mm_queue')
    .delete()
    .in('user_id', ids)
    .select('user_id');
  if (rErr) {
    console.error('mm-tick duo delete failed', rErr);
    return null;
  }
  if (!removed || removed.length < 4) {
    if (removed && removed.length > 0) {
      const survivors = [...partyA, ...partyB].filter(
        (e) => removed.find((r) => r.user_id === e.user_id),
      );
      await admin.from('mm_queue').insert(survivors.map((s) => ({
        user_id: s.user_id, game: s.game, mode: s.mode,
        party_id: s.party_id, party_size: s.party_size, rating: s.rating,
        party_avg_rating: s.party_avg_rating, band: s.band, enqueued_at: s.enqueued_at,
      })));
    }
    return null;
  }

  // Party A → seats 0+2 (team 0); Party B → seats 1+3 (team 1).
  const dealerSeat = Math.floor(Math.random() * 4);

  const { data: gRow, error: gErr } = await admin
    .from('games')
    .insert({ game, mode, status: 'playing' })
    .select('id')
    .single();
  if (gErr) {
    console.error('mm-tick duo game insert failed', gErr);
    return null;
  }
  const gameId = gRow.id;

  await admin.from('euchre_games').insert({
    game_id: gameId,
    dealer_seat: dealerSeat,
    hand_number: 0,
  });

  const playerRows: PlayerRow[] = [
    { game_id: gameId, seat: 0, user_id: partyA[0].user_id, is_bot: false, missed_turns: 0 },
    { game_id: gameId, seat: 1, user_id: partyB[0].user_id, is_bot: false, missed_turns: 0 },
    { game_id: gameId, seat: 2, user_id: partyA[1].user_id, is_bot: false, missed_turns: 0 },
    { game_id: gameId, seat: 3, user_id: partyB[1].user_id, is_bot: false, missed_turns: 0 },
  ];
  await admin.from('game_players').insert(playerRows);

  const deal = buildDealForHand(gameId, playerRows, dealerSeat as Seat, 1);
  await admin.from('game_hands').upsert(deal.hands);
  await admin.from('euchre_games').update({
    hand_number: 1,
    upcard: deal.euchre.upcard,
    upcard_status: deal.euchre.upcard_status,
  }).eq('game_id', gameId);
  await admin.from('games').update({
    current_seat: deal.current_seat,
    turn_deadline: deal.turn_deadline,
  }).eq('id', gameId);

  await admin.from('game_actions').insert({
    game_id: gameId,
    seat: dealerSeat,
    action_type: 'matchmade',
    payload: {
      mode,
      team0: [partyA[0].user_id, partyA[1].user_id],
      team1: [partyB[0].user_id, partyB[1].user_id],
      party_a: partyA[0].party_id,
      party_b: partyB[0].party_id,
      avg_rating_t0: partyA[0].party_avg_rating,
      avg_rating_t1: partyB[0].party_avg_rating,
    },
  });

  return gameId;
}
