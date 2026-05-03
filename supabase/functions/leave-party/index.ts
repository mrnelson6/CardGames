// POST /functions/v1/leave-party
// Removes the caller from their current party. If they were the leader, the
// whole party is disbanded (the other member is removed too) — keeps things
// simple; in v1 there is no "transfer leader" path.

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
} from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const admin = adminClient();

  const { data: memberships } = await admin
    .from('party_members')
    .select('party_id')
    .eq('user_id', user.id)
    .limit(1);
  const membership = (memberships ?? [])[0];
  if (!membership) return json({ ok: true, was_in_party: false });

  const { data: party } = await admin
    .from('parties')
    .select('id, leader_id')
    .eq('id', membership.party_id)
    .maybeSingle();
  if (!party) {
    // Stale membership row — clean up and bail.
    await admin.from('party_members').delete().eq('user_id', user.id);
    return json({ ok: true, was_in_party: false });
  }

  // Drop any matchmaking rows pointing at this party.
  await admin.from('mm_queue').delete().eq('party_id', party.id);

  if (party.leader_id === user.id) {
    // Disband: cascade deletes party_members for this party.
    const { error } = await admin.from('parties').delete().eq('id', party.id);
    if (error) return fail(500, 'db_disband', error.message);
    // Belt-and-suspenders: nuke any other stray rows for this user too.
    await admin.from('party_members').delete().eq('user_id', user.id);
    return json({ ok: true, disbanded: true });
  }

  // Plain leave: clear every party_members row for this user, not just
  // the one we identified above. A user is only ever supposed to be in
  // one party; if they somehow got into a state with multiple, this
  // resets them cleanly.
  const { error } = await admin
    .from('party_members')
    .delete()
    .eq('user_id', user.id);
  if (error) return fail(500, 'db_leave', error.message);
  return json({ ok: true, disbanded: false });
});
