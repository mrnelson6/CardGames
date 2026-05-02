// POST /functions/v1/join-party
// Body: { invite_code }
// Adds the caller as a member of the named party. Caps at 2 members for v1.

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';

interface Body { invite_code: string }

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;
  if (user.isAnonymous) return fail(403, 'anon_blocked', 'Sign in with email to join a party');

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.invite_code) return fail(400, 'bad_body', 'invite_code required');

  const admin = adminClient();

  const { data: party, error: pErr } = await admin
    .from('parties')
    .select('id, leader_id, invite_code')
    .eq('invite_code', body.invite_code.toUpperCase())
    .maybeSingle();
  if (pErr) return fail(500, 'db_lookup', pErr.message);
  if (!party) return fail(404, 'no_party', 'No party with that code');

  // Already a member?
  const { data: members } = await admin
    .from('party_members')
    .select('user_id')
    .eq('party_id', party.id);
  const list = (members ?? []) as Array<{ user_id: string }>;

  if (list.find((m) => m.user_id === user.id)) {
    return json({ party_id: party.id, invite_code: party.invite_code, already_member: true });
  }
  if (list.length >= 2) return fail(409, 'party_full', 'Party is full');

  // The leader can't already be in another party as member — but they're
  // tracked here, so this should be OK by construction.
  const { error: insErr } = await admin
    .from('party_members')
    .insert({ party_id: party.id, user_id: user.id });
  if (insErr) {
    if (insErr.code === '23505') return fail(409, 'already_member', 'You are already in this party');
    return fail(500, 'db_join', insErr.message);
  }

  return json({ party_id: party.id, invite_code: party.invite_code, leader_id: party.leader_id });
});
