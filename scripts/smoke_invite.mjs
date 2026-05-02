// Smoke: party leader invites a friend → friend lands in party automatically.
import { execSync } from 'node:child_process';

const PUB_KEY = process.env.PUB_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
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

async function rpc(jwt, fn, args) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: PUB_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: await r.text() };
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

console.log('--- setup: 2 users, become friends ---');
psql(`delete from party_members; delete from parties; delete from friendships; delete from friend_requests;`);

const a = await login('inv-a@test.local', 'hunter2hunter2hunter2');
const b = await login('inv-b@test.local', 'hunter2hunter2hunter2');
console.log(`  A=${a.uid}  B=${b.uid}`);

// A sends friend request to B (direct insert via RLS).
const reqResp = await fetch(`${BASE}/rest/v1/friend_requests`, {
  method: 'POST',
  headers: {
    apikey: PUB_KEY, Authorization: `Bearer ${a.jwt}`, 'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  },
  body: JSON.stringify({ from_user: a.uid, to_user: b.uid }),
});
expect(reqResp.status, 201, 'friend_request inserted');

// B accepts via RPC.
const acc = await rpc(b.jwt, 'accept_friend_request', { p_from_user: a.uid });
expect(acc.status, 204, 'accept_friend_request RPC succeeded');
const friendCount = parseInt(psql(`select count(*) from friendships where (user_a='${a.uid}' and user_b='${b.uid}') or (user_a='${b.uid}' and user_b='${a.uid}');`), 10);
expect(friendCount, 1, 'friendship row inserted');

console.log('\n--- A creates party, invites B ---');
const cp = await call(a.jwt, 'create-party', {});
expect(cp.status, 200, 'A created party');

console.log('\n--- A: invite-to-party for non-friend (should 403) ---');
// quick negative case: invite a stranger uid
const stranger = '00000000-0000-0000-0000-000000000099';
const noFriendResp = await call(a.jwt, 'invite-to-party', { to_user: stranger });
expect(noFriendResp.status, 403, 'invite rejects non-friend');
expect(noFriendResp.json.error?.code, 'not_friends', 'reason is not_friends');

console.log('\n--- A invites B (friend) ---');
const inv = await call(a.jwt, 'invite-to-party', { to_user: b.uid });
console.log('  ', inv.status, JSON.stringify(inv.json));
expect(inv.status, 200, 'invite succeeded');
const partyMembers = psql(`select user_id from party_members where party_id='${cp.json.party_id}' order by user_id;`).split('\n').sort();
const expectedMembers = [a.uid, b.uid].sort();
expect(partyMembers.join(','), expectedMembers.join(','), 'B added to party');

console.log('\n--- second invite is idempotent ---');
const inv2 = await call(a.jwt, 'invite-to-party', { to_user: b.uid });
expect(inv2.status, 200, 'second invite returns 200');
expect(inv2.json.already_member, true, 'second invite reports already_member');

console.log('\n--- B in another party blocks A from inviting ---');
// Have B leave A's party, create their own
await call(b.jwt, 'leave-party', {});
expect(psql(`select count(*) from party_members where user_id='${b.uid}';`), '0', 'B left A\'s party');
const bParty = await call(b.jwt, 'create-party', {});
expect(bParty.status, 200, 'B made own party');
const blocked = await call(a.jwt, 'invite-to-party', { to_user: b.uid });
console.log('  ', blocked.status, JSON.stringify(blocked.json));
expect(blocked.status, 409, 'invite blocked when friend already in another party');

console.log('\n--- ALL PARTY-INVITE CHECKS PASSED ---');
