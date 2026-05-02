// Smokes: resume-control flips a bot seat back to human; concurrent sweep
// invocations don't double-increment missed_turns on neighboring seats.
import { execSync } from 'node:child_process';

const PUB_KEY = process.env.PUB_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SERVICE_KEY = process.env.SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const BASE = process.env.BASE ?? 'http://127.0.0.1:54321';

async function login(email, pw) {
  let r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: PUB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  }).then((x) => x.json());
  if (r.access_token) return { jwt: r.access_token, uid: r.user.id };
  r = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: PUB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  }).then((x) => x.json());
  if (!r.access_token) throw new Error(`auth: ${JSON.stringify(r)}`);
  return { jwt: r.access_token, uid: r.user.id };
}

async function call(jwt, fn, body) {
  const r = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { apikey: PUB_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
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

console.log('--- setup: 4 users, room, force seat 0 to bot ---');
const players = [];
for (let i = 1; i <= 4; i++) {
  const p = await login(`resume${i}@test.local`, 'hunter2hunter2hunter2');
  players.push(p);
}
const c = await call(players[0].jwt, 'create-euchre-room', {});
const { game_id: gameId, invite_code } = c.json;
for (let i = 1; i < 4; i++) {
  await call(players[i].jwt, 'join-euchre-room', { invite_code });
}
expect(psql(`select status from games where id='${gameId}';`), 'playing', 'game playing');

// Find P1's seat in this game.
const seatedSeat = parseInt(psql(`select seat from game_players where game_id='${gameId}' and user_id='${players[0].uid}';`), 10);
psql(`update game_players set is_bot=true, missed_turns=2 where game_id='${gameId}' and seat=${seatedSeat};`);
expect(psql(`select is_bot from game_players where game_id='${gameId}' and seat=${seatedSeat};`), 't', `seat ${seatedSeat} forced to bot`);

console.log('\n--- P1 calls resume-control ---');
const r = await call(players[0].jwt, 'resume-control', { game_id: gameId });
console.log('  ', r.status, JSON.stringify(r.json));
expect(r.status, 200, 'resume-control 200');
expect(r.json.was_bot, true, 'was_bot reported true');
expect(psql(`select is_bot from game_players where game_id='${gameId}' and seat=${seatedSeat};`), 'f', 'is_bot flipped back to false');
expect(psql(`select missed_turns from game_players where game_id='${gameId}' and seat=${seatedSeat};`), '0', 'missed_turns reset to 0');

console.log('\n--- second call is no-op ---');
const r2 = await call(players[0].jwt, 'resume-control', { game_id: gameId });
expect(r2.status, 200, 'second resume-control 200');
expect(r2.json.was_bot, false, 'second call reports was_bot=false');

console.log('\n--- sweep race: two concurrent sweeps shouldn\'t double-increment ---');
// Force the deadline expired so a sweep WILL act.
psql(`update games set turn_deadline = now() - interval '20 seconds' where id='${gameId}';`);
const beforeNeighborMisses = parseInt(psql(`select missed_turns from game_players where game_id='${gameId}' and seat=${(seatedSeat + 1) % 4};`), 10);

// Fire two sweeps in parallel.
const sweepCall = () => fetch(`${BASE}/functions/v1/enforce-timeout-sweep`, {
  method: 'POST',
  headers: { apikey: PUB_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
  body: '{}',
}).then((r) => r.json());
const [s1, s2] = await Promise.all([sweepCall(), sweepCall()]);
console.log('  sweep 1:', JSON.stringify({ acted: s1.acted, skipped: s1.skipped }));
console.log('  sweep 2:', JSON.stringify({ acted: s2.acted, skipped: s2.skipped }));

const afterNeighborMisses = parseInt(psql(`select missed_turns from game_players where game_id='${gameId}' and seat=${(seatedSeat + 1) % 4};`), 10);
expect(afterNeighborMisses, beforeNeighborMisses, 'neighboring seat missed_turns unchanged');

console.log('\n--- ALL RESUME / RACE CHECKS PASSED ---');
