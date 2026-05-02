// POST /functions/v1/create-party
// Creates a 2-person party with the caller as leader. Generates a 6-char
// invite_code that a friend can use via join-party.

import {
  adminClient,
  authenticate,
  fail,
  generateInviteCode,
  json,
  preflight,
} from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;
  if (user.isAnonymous) {
    return fail(403, 'anon_blocked', 'Sign in with email to create a party');
  }

  const admin = adminClient();

  // If already in a party as a member, return that one (idempotent-ish).
  const { data: existing } = await admin
    .from('party_members')
    .select('party_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (existing) {
    const { data: p } = await admin
      .from('parties')
      .select('id, invite_code, leader_id')
      .eq('id', existing.party_id)
      .maybeSingle();
    if (p) {
      return json({ party_id: p.id, invite_code: p.invite_code, leader_id: p.leader_id, already_in_party: true });
    }
  }

  let attempt = 0;
  while (attempt < 5) {
    const code = generateInviteCode();
    const { data: party, error: pErr } = await admin
      .from('parties')
      .insert({ leader_id: user.id, invite_code: code })
      .select('id, invite_code, leader_id')
      .single();
    if (pErr) {
      if (pErr.code === '23505') { attempt += 1; continue; }
      return fail(500, 'db_create_party', pErr.message);
    }

    const { error: mErr } = await admin
      .from('party_members')
      .insert({ party_id: party.id, user_id: user.id });
    if (mErr) {
      await admin.from('parties').delete().eq('id', party.id);
      return fail(500, 'db_seat_leader', mErr.message);
    }

    return json({ party_id: party.id, invite_code: party.invite_code, leader_id: party.leader_id });
  }
  return fail(500, 'invite_code_collision', 'Could not generate unique party code');
});
