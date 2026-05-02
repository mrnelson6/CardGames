// POST /functions/v1/resume-control
// Body: { game_id }
// Lets a player whose seat became is_bot=true take their seat back. Resets
// missed_turns to 0 so a single timeout doesn't immediately bot them again.

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';

interface Body { game_id: string }

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;
  if (!body.game_id) return fail(400, 'bad_body', 'game_id required');

  const admin = adminClient();

  const { data: row, error: pErr } = await admin
    .from('game_players')
    .select('seat, user_id, is_bot, missed_turns')
    .eq('game_id', body.game_id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (pErr) return fail(500, 'db_lookup', pErr.message);
  if (!row) return fail(403, 'not_seated', 'You are not at this table');
  if (!row.is_bot) {
    return json({ ok: true, was_bot: false });
  }

  const upd = await admin
    .from('game_players')
    .update({ is_bot: false, missed_turns: 0 })
    .eq('game_id', body.game_id)
    .eq('seat', row.seat);
  if (upd.error) return fail(500, 'db_update', upd.error.message);

  await admin.from('game_actions').insert({
    game_id: body.game_id,
    seat: row.seat,
    action_type: 'resume_control',
    payload: {},
  });

  return json({ ok: true, was_bot: true, seat: row.seat });
});
