// Cloud smoke: 4 anon users (we won't queue duo since it requires email
// auth, but we can verify create-party is wired and rejects anon).
// Then sign up two real-domain emails (gmail.com etc.) to actually queue duo.
//
// Simpler v1: just verify the party endpoints reject anon as expected, then
// confirm enqueue-mm anon path still rejects (no regression from the
// solo→duo change).

const ANON_KEY = process.env.ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kbGN1c2lmc3B0a29iZm9oZmhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NjM2MzEsImV4cCI6MjA5MzIzOTYzMX0.fuBCvEQiQIqiPpFnZ3i9DpQnLJdLiXFMxSrJYDov7CI';
const BASE = 'https://mdlcusifsptkobfohfha.supabase.co';

async function anon() {
  const r = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {} }),
  }).then((x) => x.json());
  if (!r.access_token) throw new Error(`anon failed: ${JSON.stringify(r)}`);
  return r.access_token;
}

async function call(jwt, fn, body) {
  const resp = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json().catch(() => ({})) };
}

function expect(actual, expected, label) {
  if (actual !== expected) throw new Error(`FAIL ${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  console.log(`  ✓ ${label}`);
}

console.log('--- create-party (anon) → expect 403 anon_blocked ---');
const jwt = await anon();
const cp = await call(jwt, 'create-party', {});
console.log('  ', cp.status, JSON.stringify(cp.json));
expect(cp.status, 403, 'create-party rejects anon');
expect(cp.json.error?.code, 'anon_blocked', 'reason is anon_blocked');

console.log('\n--- join-party (anon) → expect 403 anon_blocked ---');
const jp = await call(jwt, 'join-party', { invite_code: 'AAAAAA' });
console.log('  ', jp.status, JSON.stringify(jp.json));
expect(jp.status, 403, 'join-party rejects anon');

console.log('\n--- leave-party (anon) → ok=true was_in_party=false ---');
const lp = await call(jwt, 'leave-party', {});
console.log('  ', lp.status, JSON.stringify(lp.json));
expect(lp.status, 200, 'leave-party 200');
expect(lp.json.ok, true, 'leave-party ok=true');
expect(lp.json.was_in_party, false, 'leave-party reports not in party');

console.log('\n--- enqueue-mm duo (anon) → expect 403 ---');
const eq = await call(jwt, 'enqueue-mm', { game: 'euchre', mode: 'duo' });
console.log('  ', eq.status, JSON.stringify(eq.json));
expect(eq.status, 403, 'enqueue-mm duo rejects anon');

console.log('\n--- ALL CLOUD PARTY CHECKS PASSED ---');
