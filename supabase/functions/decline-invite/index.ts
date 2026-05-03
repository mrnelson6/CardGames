// POST /functions/v1/decline-invite
// Body: { kind: 'game' | 'party', invite_id: uuid }
// Caller (must be the invite's to_user) declines the invite. The row is
// deleted and a notification is inserted for the original sender so they
// see "Alice declined your party invite".

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';

interface Body {
  kind: 'game' | 'party';
  invite_id: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.invite_id) return fail(400, 'bad_body', 'invite_id required');
  if (body.kind !== 'game' && body.kind !== 'party') {
    return fail(400, 'bad_body', "kind must be 'game' or 'party'");
  }

  const admin = adminClient();
  const table = body.kind === 'game' ? 'game_invites' : 'party_invites';

  const { data: invite, error: lookupErr } = await admin
    .from(table)
    .select('id, from_user, to_user')
    .eq('id', body.invite_id)
    .maybeSingle();
  if (lookupErr) return fail(500, 'db_lookup', lookupErr.message);
  if (!invite) return json({ ok: true, already_gone: true });
  if (invite.to_user !== user.id) return fail(403, 'not_yours', 'Invite is not for you');

  // Look up the decliner's display name once so we don't have to do it
  // client-side later.
  const { data: prof } = await admin
    .from('profiles')
    .select('username')
    .eq('user_id', user.id)
    .maybeSingle();
  const declinerUsername = (prof as { username?: string } | null)?.username ?? null;

  const { error: delErr } = await admin
    .from(table)
    .delete()
    .eq('id', body.invite_id);
  if (delErr) return fail(500, 'db_delete', delErr.message);

  const { error: notifErr } = await admin.from('notifications').insert({
    user_id: invite.from_user,
    kind: body.kind === 'game' ? 'game_invite_declined' : 'party_invite_declined',
    payload: {
      from_user: user.id,
      from_username: declinerUsername,
    },
  });
  if (notifErr) return fail(500, 'db_notif', notifErr.message);

  return json({ ok: true });
});
