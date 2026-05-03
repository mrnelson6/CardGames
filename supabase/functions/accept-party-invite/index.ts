// POST /functions/v1/accept-party-invite
// Body: { invite_id }
// Caller (must be the invite's to_user) is added to the party and the
// invite row is deleted. Returns: { party_id, invite_code }.

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';

interface Body { invite_id: string }

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.invite_id) return fail(400, 'bad_body', 'invite_id required');

  const admin = adminClient();

  const { data: invite, error: iErr } = await admin
    .from('party_invites')
    .select('id, from_user, to_user, party_id, invite_code')
    .eq('id', body.invite_id)
    .maybeSingle();
  if (iErr) return fail(500, 'db_lookup', iErr.message);
  if (!invite) return fail(404, 'no_invite', 'Invite not found');
  if (invite.to_user !== user.id) return fail(403, 'not_yours', 'Invite is not for you');

  const { data: party } = await admin
    .from('parties')
    .select('id, invite_code, leader_id')
    .eq('id', invite.party_id)
    .maybeSingle();
  if (!party) {
    await admin.from('party_invites').delete().eq('id', invite.id);
    return fail(410, 'party_gone', 'That party no longer exists');
  }

  // If the caller is already in a different party, swap them out of it.
  // - If they led that party, disband it (cascade removes the other
  //   member and any pending invites).
  // - Otherwise just drop their membership row.
  // Tolerates orphan rows pointing at a deleted party.
  const { data: existingRows } = await admin
    .from('party_members')
    .select('party_id')
    .eq('user_id', user.id)
    .limit(5);
  for (const row of (existingRows ?? []) as Array<{ party_id: string }>) {
    if (row.party_id === party.id) continue;
    const { data: oldParty } = await admin
      .from('parties')
      .select('id, leader_id')
      .eq('id', row.party_id)
      .maybeSingle();
    if (!oldParty) {
      await admin
        .from('party_members')
        .delete()
        .eq('user_id', user.id)
        .eq('party_id', row.party_id);
    } else if (oldParty.leader_id === user.id) {
      // Drop matchmaking ticket if any, then disband.
      await admin.from('mm_queue').delete().eq('party_id', oldParty.id);
      await admin.from('parties').delete().eq('id', oldParty.id);
    } else {
      await admin
        .from('party_members')
        .delete()
        .eq('party_id', oldParty.id)
        .eq('user_id', user.id);
    }
  }

  const { data: members } = await admin
    .from('party_members')
    .select('user_id')
    .eq('party_id', party.id);
  const memberIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (memberIds.includes(user.id)) {
    await admin.from('party_invites').delete().eq('id', invite.id);
    return json({ party_id: party.id, invite_code: party.invite_code, already_member: true });
  }
  if (memberIds.length >= 2) {
    await admin.from('party_invites').delete().eq('id', invite.id);
    return fail(409, 'party_full', 'Party is already full');
  }

  const { error: insErr } = await admin
    .from('party_members')
    .insert({ party_id: party.id, user_id: user.id });
  if (insErr && insErr.code !== '23505') {
    return fail(500, 'db_join', insErr.message);
  }

  await admin.from('party_invites').delete().eq('id', invite.id);

  return json({ party_id: party.id, invite_code: party.invite_code });
});
