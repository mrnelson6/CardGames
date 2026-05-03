// One-off: disband any party that has fewer than 2 members and is older
// than 30 minutes. v1 doesn't have automatic party expiry, so single-
// member parties from old sessions stick around forever and trip up
// future invites with friend_in_party.

const SERVICE_KEY = process.env.SERVICE_KEY;
const BASE = 'https://mdlcusifsptkobfohfha.supabase.co';
const STALE_MS = 30 * 60 * 1000;

if (!SERVICE_KEY) {
  console.error('Set SERVICE_KEY env var.');
  process.exit(1);
}

async function api(method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const parties = await api('GET', 'parties?select=id,leader_id,created_at');
const members = await api('GET', 'party_members?select=party_id,user_id');
const counts = new Map();
for (const m of members) counts.set(m.party_id, (counts.get(m.party_id) ?? 0) + 1);

// One-off: disband ANY 1-member party. Pass STALE=1 in env to use the
// 30-minute cutoff (intended cron behaviour); default nukes them all.
const enforceCutoff = process.env.STALE === '1';
const cutoff = Date.now() - STALE_MS;
const stale = parties.filter((p) => {
  const size = counts.get(p.id) ?? 0;
  if (size >= 2) return false;
  if (!enforceCutoff) return true;
  return new Date(p.created_at).getTime() < cutoff;
});

console.log(`Disbanding ${stale.length} stale parties:`);
for (const p of stale) {
  const size = counts.get(p.id) ?? 0;
  const ageMin = Math.round((Date.now() - new Date(p.created_at).getTime()) / 60000);
  console.log(`  ${p.id} (size=${size}, age=${ageMin}m)`);
  await api('DELETE', `parties?id=eq.${p.id}`);
}

console.log('Done.');
