// POST /functions/v1/enqueue-mm
// Body: { game: 'euchre', mode: 'solo' | 'duo' }
// Adds (or replaces) the caller's mm_queue row. Anonymous users are rejected —
// guests can only play in private rooms. Returns the queue snapshot.

import {
  adminClient,
  authenticate,
  fail,
  json,
  preflight,
  readJson,
} from '../_shared/http.ts';

interface Body {
  game: string;
  mode: string;
}

const VALID = new Map<string, Set<string>>([
  ['euchre', new Set(['solo', 'duo'])],
]);
const DEFAULT_RATING = 1000;
const STARTING_BAND = 50;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');

  const user = await authenticate(req);
  if (user instanceof Response) return user;
  if (user.isAnonymous) {
    return fail(403, 'anon_blocked', 'Sign in with email to play ranked');
  }

  const body = await readJson<Body>(req);
  if (body instanceof Response) return body;

  const game = (body.game ?? '').toLowerCase();
  const mode = (body.mode ?? '').toLowerCase();
  const allowedModes = VALID.get(game);
  if (!allowedModes || !allowedModes.has(mode)) {
    return fail(400, 'bad_combo', `unsupported game/mode: ${game}/${mode}`);
  }

  const admin = adminClient();

  // Look up caller's rating; default 1000 if no row yet.
  const callerRating = await loadRating(admin, user.id, game, mode);

  if (mode === 'solo') {
    const delErr = await admin.from('mm_queue').delete().eq('user_id', user.id);
    if (delErr.error) return fail(500, 'db_dequeue', delErr.error.message);

    const insErr = await admin.from('mm_queue').insert({
      user_id: user.id,
      game,
      mode,
      party_id: null,
      party_size: 1,
      rating: callerRating,
      party_avg_rating: callerRating,
      band: STARTING_BAND,
    });
    if (insErr.error) return fail(500, 'db_enqueue', insErr.error.message);

    return json({ ok: true, game, mode, rating: callerRating, band: STARTING_BAND });
  }

  // duo: caller must be in a 2-person party. Both members get queued together.
  const { data: membership } = await admin
    .from('party_members')
    .select('party_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!membership) return fail(409, 'no_party', 'Create or join a party before queuing duo');

  const { data: members } = await admin
    .from('party_members')
    .select('user_id')
    .eq('party_id', membership.party_id);
  const memberIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (memberIds.length !== 2) {
    return fail(409, 'party_size', `Duo requires exactly 2 party members (have ${memberIds.length})`);
  }

  const ratings = await Promise.all(memberIds.map((id) => loadRating(admin, id, game, mode)));
  const partyAvg = Math.round((ratings[0] + ratings[1]) / 2);

  // Drop any prior queue rows for either member, then atomically insert two.
  const delErr = await admin.from('mm_queue').delete().in('user_id', memberIds);
  if (delErr.error) return fail(500, 'db_dequeue', delErr.error.message);

  const rows = memberIds.map((id, i) => ({
    user_id: id,
    game,
    mode,
    party_id: membership.party_id,
    party_size: 2,
    rating: ratings[i],
    party_avg_rating: partyAvg,
    band: STARTING_BAND,
  }));
  const insErr = await admin.from('mm_queue').insert(rows);
  if (insErr.error) return fail(500, 'db_enqueue', insErr.error.message);

  return json({
    ok: true,
    game,
    mode,
    party_id: membership.party_id,
    party_avg_rating: partyAvg,
    band: STARTING_BAND,
  });
});

async function loadRating(
  admin: ReturnType<typeof adminClient>,
  userId: string,
  game: string,
  mode: string,
): Promise<number> {
  const { data } = await admin
    .from('ratings')
    .select('elo')
    .eq('user_id', userId)
    .eq('game', game)
    .eq('mode', mode)
    .maybeSingle();
  return (data?.elo as number | undefined) ?? DEFAULT_RATING;
}
