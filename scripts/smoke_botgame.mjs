// Smoke: human + 3 bots starts immediately, bots have hands, autoAdvance
// runs through any pre-human bots (depending on dealer position) before
// returning so the response is "ready for human input."
import { execSync } from 'node:child_process';

const PUB_KEY = process.env.PUB_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const BASE = process.env.BASE ?? 'http://127.0.0.1:54321';

async function login(email, pw) {
  let r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: PUB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  }).then((x) => x.json());
  if (r.access_token) return { jwt: r.access_token, uid: r.user.id };
  r = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: PUB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  }).then((x) => x.json());
  if (!r.access_token) throw new Error(`auth: ${JSON.stringify(r)}`);
  return { jwt: r.access_token, uid: r.user.id };
}

async function call(jwt, fn, body) {
  const r = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { apikey: PUB_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

function psql(q) {
  return execSync(
    `docker exec supabase_db_CardGames psql -U postgres -d postgres -t -A -c ${JSON.stringify(q)}`,
    { encoding: 'utf8' },
  ).trim();
}

function expect(actual, expected, label) {
  if (actual !== expected) throw new Error(`FAIL ${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  console.log(`  ✓ ${label}`);
}

console.log('--- create bot game ---');
const me = await login('botgame@test.local', 'hunter2hunter2hunter2');
const t0 = Date.now();
const r = await call(me.jwt, 'create-bot-game', {});
const elapsed = Date.now() - t0;
console.log('  ', r.status, JSON.stringify(r.json), `(${elapsed}ms)`);
expect(r.status, 200, 'create-bot-game 200');
const gameId = r.json.game_id;

console.log('\n--- assertions ---');
expect(psql(`select status from games where id='${gameId}';`), 'playing', 'status=playing');
expect(psql(`select count(*) from game_players where game_id='${gameId}';`), '4', '4 players seated');
expect(psql(`select count(*) from game_players where game_id='${gameId}' and is_bot=true;`), '3', '3 are bots');
expect(psql(`select count(*) from game_players where game_id='${gameId}' and user_id='${me.uid}' and is_bot=false;`), '1', 'human at one seat');
expect(psql(`select count(*) from game_hands where game_id='${gameId}';`), '4', '4 hands dealt');

const handSizes = psql(`select array_length(cards,1) from game_hands where game_id='${gameId}' order by seat;`).split('\n').map(s => parseInt(s, 10));
console.log(`  hand sizes: ${handSizes.join(',')}`);
const totalCards = handSizes.reduce((a, b) => a + b, 0);
// Bots may have already played some cards by now (autoAdvance ran). All four
// hands started at 5 = 20 total; some may have decreased. Sum should equal
// 20 minus however many cards have been played in tricks.
const playsCount = parseInt(psql(`select count(*) from trick_plays tp join tricks t on t.id=tp.trick_id where t.game_id='${gameId}';`), 10);
expect(totalCards + playsCount, 20, 'cards-in-hand + cards-played = 20');

const dealer = parseInt(psql(`select dealer_seat from euchre_games where game_id='${gameId}';`), 10);
const humanSeat = parseInt(psql(`select seat from game_players where game_id='${gameId}' and user_id='${me.uid}';`), 10);
console.log(`  dealer seat: ${dealer}; human seat: ${humanSeat}`);

const currentSeat = parseInt(psql(`select current_seat from games where id='${gameId}';`), 10);
const currentIsBot = psql(`select is_bot from game_players where game_id='${gameId}' and seat=${currentSeat};`);
console.log(`  current_seat=${currentSeat} (is_bot=${currentIsBot})`);
// After autoAdvance, current_seat must NOT be a bot — otherwise the human is
// stuck waiting forever for the next request to fire bot moves.
expect(currentIsBot, 'f', 'autoAdvance left current_seat at the human or a finished phase');

console.log('\n--- ALL BOT-GAME CHECKS PASSED ---');
