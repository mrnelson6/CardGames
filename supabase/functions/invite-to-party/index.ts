// POST /functions/v1/invite-to-party
// Body: { to_user: uuid }
// Leader-only. Sends a pending party invitation that the friend must
// accept before they're added to party_members. Friendship is required.
// Returns: { ok, party_id, invite_id?, already_member?, already_invited? }

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';

interface Body { to_user: string }

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;
  if (user.isAnonymous) return fail(403, 'anon_blocked', 'Sign in with email to invite friends');

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.to_user) return fail(400, 'bad_body', 'to_user required');
  if (body.to_user === user.id) return fail(400, 'self_invite', "Can't invite yourself");

  const admin = adminClient();

  const { data: party, error: pErr } = await admin
    .from('parties')
    .select('id, leader_id, invite_code')
    .eq('leader_id', user.id)
    .maybeSingle();
  if (pErr) return fail(500, 'db_party', pErr.message);
  if (!party) return fail(409, 'no_party', 'Create a party before inviting friends');

  const lo = user.id < body.to_user ? user.id : body.to_user;
  const hi = user.id < body.to_user ? body.to_user : user.id;
  const { data: friendship } = await admin
    .from('friendships')
    .select('user_a')
    .eq('user_a', lo)
    .eq('user_b', hi)
    .maybeSingle();
  if (!friendship) return fail(403, 'not_friends', 'You can only invite friends');

  const { data: members } = await admin
    .from('party_members')
    .select('user_id')
    .eq('party_id', party.id);
  const memberIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (memberIds.includes(body.to_user)) {
    return json({ ok: true, party_id: party.id, already_member: true });
  }
  if (memberIds.length >= 2) return fail(409, 'party_full', 'Party is full');

  const { data: other } = await admin
    .from('party_members')
    .select('party_id')
    .eq('user_id', body.to_user)
    .maybeSingle();
  if (other && other.party_id !== party.id) {
    return fail(409, 'friend_in_party', 'They are already in another party');
  }

  // Create or refresh the pending invite row.
  const { data: invite, error: invErr } = await admin
    .from('party_invites')
    .upsert(
      {
        from_user: user.id,
        to_user: body.to_user,
        party_id: party.id,
        invite_code: party.invite_code,
      },
      { onConflict: 'from_user,to_user,party_id' },
    )
    .select('id')
    .single();
  if (invErr) return fail(500, 'db_invite', invErr.message);

  return json({ ok: true, party_id: party.id, invite_id: invite.id });
});
