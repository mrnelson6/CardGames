// Phase 3 smoke test: stand up a game, force a turn deadline into the past
// via direct DB write, then prove (a) enforce-timeout fires a bot move and
// (b) enforce-timeout-sweep does the same when invoked directly.
//
// Run: node scripts/smoke_timeout.mjs
// Pre-reqs: `supabase start` and `supabase functions serve` running, plus
// the local vault secrets set via scripts/setup_cron_secrets.sh.

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

async function call(jwt, fn, body) {
  const resp = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { apikey: PUB_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
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

const players = [];
for (let i = 1; i <= 4; i++) {
  const p = await login(`tt${i}@test.local`, 'hunter2hunter2hunter2');
  players.push(p);
}

console.log('--- create + join 4 ---');
const c = await call(players[0].jwt, 'create-euchre-room', {});
const { game_id: gameId, invite_code: invite } = c.json;
for (let i = 1; i < 4; i++) {
  await call(players[i].jwt, 'join-euchre-room', { invite_code: invite });
}
expect(psql(`select status from games where id='${gameId}';`), 'playing', 'started');

const seatedSeat = parseInt(psql(`select current_seat from games where id='${gameId}';`), 10);
const seatedUid = psql(`select user_id from game_players where game_id='${gameId}' and seat=${seatedSeat};`);
const seatedPlayer = players.find((p) => p.uid === seatedUid);

console.log('\n--- 1st enforce-timeout: state-not-moved short-circuit ---');
// Deadline hasn't actually expired yet — server should return acted=false.
const realDeadline = psql(`select turn_deadline from games where id='${gameId}';`);
const r1 = await call(seatedPlayer.jwt, 'enforce-timeout', {
  game_id: gameId,
  expected_seat: seatedSeat,
  expected_deadline: new Date(realDeadline).toISOString(),
});
console.log('  resp:', r1.status, JSON.stringify(r1.json));
expect(r1.json.acted, false, 'no-op when deadline still in the future');

console.log('\n--- force deadline into the past + fire enforce-timeout ---');
psql(`update games set turn_deadline = now() - interval '10 seconds' where id='${gameId}';`);
const expiredDeadline = psql(`select turn_deadline from games where id='${gameId}';`);
const r2 = await call(seatedPlayer.jwt, 'enforce-timeout', {
  game_id: gameId,
  expected_seat: seatedSeat,
  expected_deadline: new Date(expiredDeadline).toISOString(),
});
console.log('  resp:', r2.status, JSON.stringify(r2.json));
expect(r2.json.acted, true, 'enforce-timeout acted on expired deadline');
expect(parseInt(psql(`select missed_turns from game_players where game_id='${gameId}' and seat=${seatedSeat};`), 10), 1, 'missed_turns incremented to 1');
expect(psql(`select is_bot from game_players where game_id='${gameId}' and seat=${seatedSeat};`), 'f', 'still human after first miss');

const newCurrentSeat = parseInt(psql(`select current_seat from games where id='${gameId}';`), 10);
console.log('  current_seat moved to', newCurrentSeat);

console.log('\n--- second timeout on same player flips to is_bot ---');
// Force the game into a clean play phase so seat 0 can act regardless of role.
psql(`update euchre_games set trump_suit='S', upcard=null, upcard_status='taken', maker_seat=${seatedSeat}, alone_seat=null, current_trick_id=null where game_id='${gameId}';`);
psql(`update games set current_seat=${seatedSeat}, turn_deadline=now() - interval '10 seconds' where id='${gameId}';`);
const r3 = await call(seatedPlayer.jwt, 'enforce-timeout', {
  game_id: gameId,
  expected_seat: seatedSeat,
  expected_deadline: new Date(psql(`select turn_deadline from games where id='${gameId}';`)).toISOString(),
});
console.log('  resp:', r3.status, JSON.stringify(r3.json));
expect(r3.json.acted, true, 'second timeout acted');
expect(psql(`select is_bot from game_players where game_id='${gameId}' and seat=${seatedSeat};`), 't', 'flipped to is_bot after second miss');

console.log('\n--- enforce-timeout-sweep direct invocation ---');
psql(`update games set turn_deadline = now() - interval '20 seconds' where id='${gameId}' and status='playing';`);
const sw = await fetch(`${BASE}/functions/v1/enforce-timeout-sweep`, {
  method: 'POST',
  headers: { apikey: PUB_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
  body: '{}',
}).then((r) => r.json());
console.log('  sweep:', JSON.stringify(sw));
if (psql(`select status from games where id='${gameId}';`) === 'playing') {
  // Sweep should have advanced the seat (and the bot turn fires recursively).
  const newDeadline = psql(`select turn_deadline from games where id='${gameId}';`);
  const oldEnoughOk = new Date(newDeadline).getTime() > Date.now() - 5_000;
  expect(oldEnoughOk, true, 'sweep refreshed turn_deadline');
}

console.log('\n--- ALL PHASE 3 TIMEOUT CHECKS PASSED ---');
