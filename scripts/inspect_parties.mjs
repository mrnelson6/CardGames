// One-off: dump the full state of public.parties, public.party_members,
// and public.party_invites so we can see what's actually in the cloud DB.

const SERVICE_KEY = process.env.SERVICE_KEY;
const BASE = 'https://mdlcusifsptkobfohfha.supabase.co';

if (!SERVICE_KEY) {
  console.error('Set SERVICE_KEY env var (service_role JWT).');
  process.exit(1);
}

async function q(table, params = '') {
  const r = await fetch(`${BASE}/rest/v1/${table}?${params}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${table}: ${r.status} ${text}`);
  return JSON.parse(text);
}

const [parties, members, invites] = await Promise.all([
  q('parties', 'select=id,leader_id,invite_code,created_at'),
  q('party_members', 'select=party_id,user_id,joined_at'),
  q('party_invites', 'select=id,from_user,to_user,party_id,created_at'),
]);

console.log(`parties (${parties.length}):`);
for (const p of parties) console.log(' ', JSON.stringify(p));

console.log(`\nparty_members (${members.length}):`);
for (const m of members) console.log(' ', JSON.stringify(m));

console.log(`\nparty_invites (${invites.length}):`);
for (const i of invites) console.log(' ', JSON.stringify(i));

const partyIds = new Set(parties.map((p) => p.id));
const orphanMembers = members.filter((m) => !partyIds.has(m.party_id));
const orphanInvites = invites.filter((i) => !partyIds.has(i.party_id));

console.log(`\norphan party_members (point to deleted party): ${orphanMembers.length}`);
for (const m of orphanMembers) console.log(' ', JSON.stringify(m));

console.log(`orphan party_invites: ${orphanInvites.length}`);
for (const i of orphanInvites) console.log(' ', JSON.stringify(i));
