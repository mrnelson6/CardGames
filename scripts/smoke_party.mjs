// Smoke: 2 parties of 2 → duo queue → mm-tick pairs them into one game.
import { execSync } from 'node:child_process';

const PUB_KEY = process.env.PUB_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SERVICE_KEY = process.env.SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const BASE = process.env.BASE ?? 'http://127.0.0.1:54321';

async function login(email, pw) {
  let r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  }).then((x) => x.json());
  if (r.access_token) return { jwt: r.access_token, uid: r.user.id };
  r = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: PUB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  }).then((x) => x.json());
  if (!r.access_token) throw new Error(`auth failed: ${JSON.stringify(r)}`);
  return { jwt: r.access_token, uid: r.user.id };
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

console.log('--- create 4 users ---');
psql(`delete from mm_queue;`);
psql(`delete from party_members;`);
psql(`delete from parties;`);

const players = [];
for (let i = 1; i <= 4; i++) {
  const p = await login(`party${i}@test.local`, 'hunter2hunter2hunter2');
  players.push(p);
}

console.log('\n--- party A: P1 creates, P2 joins ---');
const aCreate = await call(players[0].jwt, 'create-party', {});
console.log('  create:', aCreate.status, JSON.stringify(aCreate.json));
expect(aCreate.status, 200, 'P1 created party');
const aCode = aCreate.json.invite_code;

const aJoin = await call(players[1].jwt, 'join-party', { invite_code: aCode });
console.log('  join:', aJoin.status, JSON.stringify(aJoin.json));
expect(aJoin.status, 200, 'P2 joined party A');

console.log('\n--- party B: P3 creates, P4 joins ---');
const bCreate = await call(players[2].jwt, 'create-party', {});
expect(bCreate.status, 200, 'P3 created party');
const bCode = bCreate.json.invite_code;

const bJoin = await call(players[3].jwt, 'join-party', { invite_code: bCode });
expect(bJoin.status, 200, 'P4 joined party B');

console.log('\n--- enqueue both parties for duo ---');
const aQ = await call(players[0].jwt, 'enqueue-mm', { game: 'euchre', mode: 'duo' });
console.log('  party A enqueue:', aQ.status, JSON.stringify(aQ.json));
expect(aQ.status, 200, 'party A queued');

const bQ = await call(players[2].jwt, 'enqueue-mm', { game: 'euchre', mode: 'duo' });
console.log('  party B enqueue:', bQ.status, JSON.stringify(bQ.json));
expect(bQ.status, 200, 'party B queued');

const queueSize = parseInt(psql(`select count(*) from mm_queue;`), 10);
expect(queueSize, 4, 'four mm_queue rows (2 per party)');

console.log('\n--- fire mm-tick ---');
const tick = await fetch(`${BASE}/functions/v1/mm-tick`, {
  method: 'POST',
  headers: { apikey: PUB_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
  body: '{}',
}).then((r) => r.json());
console.log('  tick:', JSON.stringify(tick));
expect(tick.created.length, 1, 'one duo game created');

const gameId = tick.created[0];
expect(psql(`select count(*) from mm_queue;`), '0', 'queue drained');
expect(psql(`select mode from games where id='${gameId}';`), 'duo', 'mode=duo on matchmade game');
expect(psql(`select status from games where id='${gameId}';`), 'playing', 'duo game is playing');

const teamA = psql(`select user_id from game_players where game_id='${gameId}' and seat in (0,2) order by seat;`).split('\n').sort();
const partyAMembers = [players[0].uid, players[1].uid].sort();
expect(teamA.join(','), partyAMembers.join(','), 'party A on team 0 (seats 0+2)');

const teamB = psql(`select user_id from game_players where game_id='${gameId}' and seat in (1,3) order by seat;`).split('\n').sort();
const partyBMembers = [players[2].uid, players[3].uid].sort();
expect(teamB.join(','), partyBMembers.join(','), 'party B on team 1 (seats 1+3)');

console.log('\n--- ALL DUO/PARTY CHECKS PASSED ---');
