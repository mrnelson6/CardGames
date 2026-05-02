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
  ['euchre', new Set(['solo'])], // duo lands once parties are wired
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

  // Look up rating; default 1000 if no row yet.
  const { data: ratingRow, error: rErr } = await admin
    .from('ratings')
    .select('elo')
    .eq('user_id', user.id)
    .eq('game', game)
    .eq('mode', mode)
    .maybeSingle();
  if (rErr) return fail(500, 'db_rating', rErr.message);
  const rating = ratingRow?.elo ?? DEFAULT_RATING;

  // Upsert: a user is in at most one queue at a time.
  const { error: delErr } = await admin
    .from('mm_queue')
    .delete()
    .eq('user_id', user.id);
  if (delErr) return fail(500, 'db_dequeue', delErr.message);

  const { error: insErr } = await admin.from('mm_queue').insert({
    user_id: user.id,
    game,
    mode,
    party_id: null,
    party_size: 1,
    rating,
    party_avg_rating: rating,
    band: STARTING_BAND,
  });
  if (insErr) return fail(500, 'db_enqueue', insErr.message);

  return json({ ok: true, game, mode, rating, band: STARTING_BAND });
});
