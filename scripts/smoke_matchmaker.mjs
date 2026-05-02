// Phase 4 smoke test: 4 users enqueue → mm-tick pairs them → game starts.
// Run: node scripts/smoke_matchmaker.mjs

import { execSync } from 'node:child_process';

const PUB_KEY = process.env.PUB_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SERVICE_KEY = process.env.SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
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
  if (!resp.access_token) throw new Error(`auth failed: ${JSON.stringify(resp)}`);
  return { jwt: resp.access_token, uid: resp.user.id };
}

async function call(jwt, fn, body, extraHeaders = {}) {
  const resp = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      apikey: PUB_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json().catch(() => ({})) };
}

function psql(q) {
  return execSync(
    `docker exec supabase_db_CardGames psql -U postgres -d postgres -t -A -c ${JSON.stringify(q)}`,
    { encoding: 'utf8' },
  ).trim();
}

function expect(actual, expected, label) {
  if (actual !== expected) throw new Error(`FAIL ${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  console.log(`  ✓ ${label}`);
}

console.log('--- enqueue 4 users for solo ---');
psql(`delete from mm_queue;`); // clean slate

const players = [];
for (let i = 1; i <= 4; i++) {
  const p = await login(`mm${i}@test.local`, 'hunter2hunter2hunter2');
  players.push(p);
  const r = await call(p.jwt, 'enqueue-mm', { game: 'euchre', mode: 'solo' });
  if (r.status !== 200) throw new Error(`P${i} enqueue failed: ${JSON.stringify(r.json)}`);
  console.log(`  P${i} enqueued at rating ${r.json.rating}`);
}

const queueSize = parseInt(psql(`select count(*) from mm_queue;`), 10);
expect(queueSize, 4, 'four entries in mm_queue');

console.log('\n--- fire mm-tick directly ---');
const tickResp = await fetch(`${BASE}/functions/v1/mm-tick`, {
  method: 'POST',
  headers: {
    apikey: PUB_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: '{}',
}).then((r) => r.json());
console.log('  tick:', JSON.stringify(tickResp));
expect(tickResp.created.length, 1, 'one game created');

const newGameId = tickResp.created[0];
expect(psql(`select count(*) from mm_queue;`), '0', 'queue drained');
expect(psql(`select status from games where id='${newGameId}';`), 'playing', 'matchmade game is playing');
expect(psql(`select mode from games where id='${newGameId}';`), 'solo', 'mode=solo on matchmade game');

console.log('\n--- seat occupancy ---');
const seats = psql(`select seat || ':' || user_id from game_players where game_id='${newGameId}' order by seat;`).split('\n');
console.log('  seats:', seats.join(' '));
expect(seats.length, 4, 'four seats filled');

const handSizes = psql(`select array_length(cards, 1) from game_hands where game_id='${newGameId}' order by seat;`).split('\n');
for (const s of handSizes) expect(s, '5', 'hand dealt 5 cards');

const dealer = psql(`select dealer_seat from euchre_games where game_id='${newGameId}';`);
const upcardStatus = psql(`select upcard_status from euchre_games where game_id='${newGameId}';`);
console.log(`  dealer=${dealer} upcard_status=${upcardStatus}`);
expect(upcardStatus, 'face_up', 'upcard face up');

console.log('\n--- ALL MATCHMAKING CHECKS PASSED ---');
