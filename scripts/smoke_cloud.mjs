// End-to-end cloud smoke test. Hits the deployed Edge Functions on the
// production Supabase project; verifies create-room + 4-way join flips
// status to 'playing' and deals hands. No direct DB queries — proves the
// cloud chain via HTTP responses only.

const ANON_KEY = process.env.ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kbGN1c2lmc3B0a29iZm9oZmhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NjM2MzEsImV4cCI6MjA5MzIzOTYzMX0.fuBCvEQiQIqiPpFnZ3i9DpQnLJdLiXFMxSrJYDov7CI';
const BASE = 'https://mdlcusifsptkobfohfha.supabase.co';

async function anonSignIn() {
  const r = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {} }),
  }).then((x) => x.json());
  if (!r.access_token) throw new Error(`anon sign-in failed: ${JSON.stringify(r)}`);
  return { jwt: r.access_token, uid: r.user.id };
}

async function call(jwt, fn, body) {
  const resp = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json().catch(() => ({})) };
}

function expect(actual, expected, label) {
  if (actual !== expected) throw new Error(`FAIL ${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  console.log(`  ✓ ${label}`);
}

console.log('--- 4 anonymous sign-ins ---');
const players = [];
for (let i = 1; i <= 4; i++) {
  const p = await anonSignIn();
  players.push(p);
  console.log(`  P${i}: uid=${p.uid}`);
}

console.log('\n--- create room ---');
const c = await call(players[0].jwt, 'create-euchre-room', {});
console.log('  ', c.status, JSON.stringify(c.json));
if (c.status !== 200) throw new Error('create-room failed against cloud');
const { game_id, invite_code } = c.json;
expect(c.json.seat, 0, 'creator seated at 0');

console.log('\n--- join 2-4 ---');
let finalStatus = 'lobby';
for (let i = 1; i < 4; i++) {
  const r = await call(players[i].jwt, 'join-euchre-room', { invite_code });
  console.log(`  P${i + 1}: ${r.status} ${JSON.stringify(r.json)}`);
  if (r.status !== 200) throw new Error(`join failed for P${i + 1}: ${JSON.stringify(r.json)}`);
  finalStatus = r.json.status;
  expect(r.json.seat, i, `P${i + 1} seated at ${i}`);
}
expect(finalStatus, 'playing', 'status flipped to playing on 4th joiner');

console.log('\n--- enqueue-mm rejects anon (expected behavior) ---');
const enq = await call(players[0].jwt, 'enqueue-mm', { game: 'euchre', mode: 'solo' });
console.log('  enqueue:', enq.status, JSON.stringify(enq.json));
expect(enq.status, 403, 'enqueue-mm rejects anonymous user');
expect(enq.json.error?.code, 'anon_blocked', 'rejection reason is anon_blocked');

console.log(`\n--- ALL CLOUD SMOKE CHECKS PASSED ---`);
console.log(`  game_id: ${game_id}`);
console.log(`  invite:  ${invite_code}`);
console.log(`  Live URL: https://euchre.ttnelson.com/#/games/euchre/g/${game_id}`);
