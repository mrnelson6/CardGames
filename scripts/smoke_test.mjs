// End-to-end smoke test of Edge Functions against the local Supabase stack.
// Run: node scripts/smoke_test.mjs
// Pre-reqs: `supabase start` and `supabase functions serve` running.

import { execSync } from 'node:child_process';

const PUB_KEY = process.env.PUB_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const BASE = process.env.BASE ?? 'http://127.0.0.1:54321';

async function login(email, password) {
  let resp = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json());
  if (resp.access_token) return { jwt: resp.access_token, uid: resp.user.id };

  resp = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: PUB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json());
  if (!resp.access_token) throw new Error(`auth failed for ${email}: ${JSON.stringify(resp)}`);
  return { jwt: resp.access_token, uid: resp.user.id };
}

async function call(jwt, fn, body) {
  const resp = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      apikey: PUB_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, json };
}

function psql(q) {
  const out = execSync(
    `docker exec supabase_db_CardGames psql -U postgres -d postgres -t -A -c ${JSON.stringify(q)}`,
    { encoding: 'utf8' },
  );
  return out.trim();
}

function expect(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${label}`);
}

const players = [];
for (let i = 1; i <= 4; i++) {
  const p = await login(`smoke${i}@test.local`, 'hunter2hunter2hunter2');
  players.push(p);
  console.log(`P${i}: uid=${p.uid}`);
}

console.log('\n--- create room ---');
const create = await call(players[0].jwt, 'create-euchre-room', {});
console.log('create-euchre-room:', create.status, JSON.stringify(create.json));
if (create.status !== 200) throw new Error('create failed');
const { game_id: gameId, invite_code: invite } = create.json;
expect(create.json.seat, 0, 'creator seated at 0');

console.log('\n--- join 2-4 ---');
for (let i = 1; i < 4; i++) {
  const r = await call(players[i].jwt, 'join-euchre-room', { invite_code: invite });
  console.log(`P${i + 1} join:`, r.status, JSON.stringify(r.json));
  if (r.status !== 200) throw new Error(`join failed for P${i + 1}`);
}

console.log('\n--- post-join state ---');
const status = psql(`select status from games where id='${gameId}';`);
expect(status, 'playing', 'status=playing after 4th joiner');

const dealer = parseInt(psql(`select dealer_seat from euchre_games where game_id='${gameId}';`), 10);
console.log(`  dealer=${dealer}`);
const handSizes = psql(`select seat || '=' || coalesce(array_length(cards,1), 0) from game_hands where game_id='${gameId}' order by seat;`).split('\n');
console.log(`  hands:`, handSizes.join(' '));
for (const hs of handSizes) {
  expect(hs.split('=')[1], '5', `seat ${hs.split('=')[0]} has 5 cards`);
}

const upcard = psql(`select upcard from euchre_games where game_id='${gameId}';`);
const upcardStatus = psql(`select upcard_status from euchre_games where game_id='${gameId}';`);
console.log(`  upcard=${upcard} status=${upcardStatus}`);
expect(upcardStatus, 'face_up', 'upcard face_up at hand start');

let currentSeat = parseInt(psql(`select current_seat from games where id='${gameId}';`), 10);
expect(currentSeat, (dealer + 1) % 4, 'first bidder = dealer+1');

// Find which player object owns currentSeat.
function playerForSeat(seat) {
  const uid = psql(`select user_id from game_players where game_id='${gameId}' and seat=${seat};`);
  const idx = players.findIndex((p) => p.uid === uid);
  if (idx < 0) throw new Error(`no player for seat ${seat}, uid=${uid}`);
  return players[idx];
}

console.log('\n--- bidding: order up ---');
const bidder = playerForSeat(currentSeat);
const orderUp = await call(bidder.jwt, 'euchre-bid-action', {
  game_id: gameId,
  action: 'order_up',
});
console.log('order_up:', orderUp.status, JSON.stringify(orderUp.json));
expect(orderUp.status, 200, 'order_up accepted');

const upcardSuit = upcard.slice(1);
const trump = psql(`select trump_suit from euchre_games where game_id='${gameId}';`);
expect(trump, upcardSuit, 'trump set to upcard suit');
expect(psql(`select upcard_status from euchre_games where game_id='${gameId}';`), 'taken', 'upcard taken');
expect(parseInt(psql(`select array_length(cards,1) from game_hands where game_id='${gameId}' and seat=${dealer};`), 10), 6, 'dealer hand grew to 6 after order-up');

console.log('\n--- discard ---');
const dealerPlayer = playerForSeat(dealer);
const dealerHand = psql(`select cards[1] from game_hands where game_id='${gameId}' and seat=${dealer};`);
const discardResp = await call(dealerPlayer.jwt, 'euchre-discard', {
  game_id: gameId,
  card: dealerHand,
});
console.log('discard:', discardResp.status, JSON.stringify(discardResp.json));
expect(discardResp.status, 200, 'discard accepted');
expect(parseInt(psql(`select array_length(cards,1) from game_hands where game_id='${gameId}' and seat=${dealer};`), 10), 5, 'dealer back to 5 cards');
expect(psql(`select upcard from euchre_games where game_id='${gameId}';`), '', 'upcard cleared after discard');
expect(psql(`select discarded_card from game_hands where game_id='${gameId}' and seat=${dealer};`), dealerHand, 'discarded_card recorded');

console.log('\n--- play 4 cards (one full trick) ---');
let trickWinnerSeat = null;
for (let i = 0; i < 4; i++) {
  currentSeat = parseInt(psql(`select current_seat from games where id='${gameId}';`), 10);
  const p = playerForSeat(currentSeat);
  const card = psql(`select cards[1] from game_hands where game_id='${gameId}' and seat=${currentSeat};`);
  const r = await call(p.jwt, 'euchre-play-card', { game_id: gameId, card });
  if (r.status !== 200) {
    console.log('play-card failed:', r.status, JSON.stringify(r.json));
    // It might be illegal (must follow suit). Try a card that follows suit.
    const ledSuit = (psql(`select led_suit from tricks where game_id='${gameId}' order by trick_number desc limit 1;`));
    const cards = psql(`select array_to_string(cards, ',') from game_hands where game_id='${gameId}' and seat=${currentSeat};`).split(',').filter(Boolean);
    // simple fallback: try each card until one accepts
    let played = false;
    for (const candidate of cards) {
      const r2 = await call(p.jwt, 'euchre-play-card', { game_id: gameId, card: candidate });
      if (r2.status === 200) { played = true; console.log(`  fallback played ${candidate} for seat ${currentSeat}`); break; }
    }
    if (!played) throw new Error(`could not find legal play for seat ${currentSeat}, ledSuit=${ledSuit}, cards=${cards}`);
  } else {
    console.log(`  seat ${currentSeat} played ${card} -> ${JSON.stringify(r.json)}`);
    if (r.json.trick_winner !== undefined) trickWinnerSeat = r.json.trick_winner;
  }
}

console.log(`\n  trick winner: seat ${trickWinnerSeat}`);
const trickRow = psql(`select trick_number || ',' || winner_seat from tricks where game_id='${gameId}' order by trick_number desc limit 1;`);
console.log(`  latest trick: ${trickRow}`);
expect(trickRow.startsWith('1,'), true, 'first trick recorded');

const handSizesAfter = psql(`select array_length(cards, 1) from game_hands where game_id='${gameId}' order by seat;`).split('\n');
for (const s of handSizesAfter) expect(s, '4', 'all hands down to 4 cards after trick 1');

console.log('\n--- ALL SMOKE CHECKS PASSED ---');
