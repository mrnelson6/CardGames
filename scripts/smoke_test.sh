#!/usr/bin/env bash
# End-to-end smoke test of Edge Functions against the local Supabase stack.
# Spins up 4 users, creates a room, joins all four, walks through bidding and
# enough card play to confirm the trick + hand resolution paths run.
#
# Pre-reqs: `supabase start` and `supabase functions serve` running.
set -euo pipefail

PUB_KEY="${PUB_KEY:-sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH}"
BASE="${BASE:-http://127.0.0.1:54321}"

require_jq() {
  if ! command -v jq >/dev/null; then
    echo "jq required" >&2; exit 1
  fi
}
require_jq

login() {
  local email=$1 pw=$2
  # Try signin first; fall back to signup (handles clean DBs and re-runs).
  local resp
  resp=$(curl -s -X POST "$BASE/auth/v1/token?grant_type=password" \
    -H "apikey: $PUB_KEY" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$pw\"}")
  if echo "$resp" | jq -e '.access_token' >/dev/null 2>&1; then
    echo "$resp" | jq -r '.access_token + " " + .user.id'
    return
  fi
  resp=$(curl -s -X POST "$BASE/auth/v1/signup" \
    -H "apikey: $PUB_KEY" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$pw\"}")
  echo "$resp" | jq -r '.access_token + " " + .user.id'
}

call() {
  local jwt=$1 fn=$2 body=$3
  curl -s -X POST "$BASE/functions/v1/$fn" \
    -H "apikey: $PUB_KEY" \
    -H "Authorization: Bearer $jwt" \
    -H "Content-Type: application/json" \
    -d "$body"
}

declare -a JWT UID
for i in 1 2 3 4; do
  read -r tok uid <<<"$(login "smoke${i}@test.local" "hunter2hunter2hunter2")"
  JWT[$i]=$tok
  UID[$i]=$uid
  echo "P$i uid=$uid"
done

echo "--- create room ---"
create_resp=$(call "${JWT[1]}" create-euchre-room '{}')
echo "$create_resp" | jq .
GAME_ID=$(echo "$create_resp" | jq -r .game_id)
INVITE=$(echo "$create_resp" | jq -r .invite_code)

echo "--- join 2,3,4 ---"
for i in 2 3 4; do
  resp=$(call "${JWT[$i]}" join-euchre-room "{\"invite_code\":\"$INVITE\"}")
  echo "P$i: $(echo "$resp" | jq -c .)"
done

echo "--- game state ---"
psql_q() {
  docker exec supabase_db_CardGames psql -U postgres -d postgres -t -A -c "$1"
}

psql_q "select status, current_seat, team0_score, team1_score from games where id='$GAME_ID';"
psql_q "select dealer_seat, hand_number, upcard, upcard_status, trump_suit from euchre_games where game_id='$GAME_ID';"
psql_q "select seat, user_id, is_bot from game_players where game_id='$GAME_ID' order by seat;"
echo "hand sizes:"
psql_q "select seat, array_length(cards, 1) from game_hands where game_id='$GAME_ID' order by seat;"

# Determine current seat and that user's index.
status=$(psql_q "select status from games where id='$GAME_ID';")
if [[ "$status" != "playing" ]]; then
  echo "FAIL: status=$status, expected playing"; exit 1
fi
echo "✓ game transitioned to playing"

# Walk: every seat passes round 1, then dealer is forced to call trump in round 2 by stick-the-dealer.
# But to keep it simple for smoke, have the first player order up.
current_seat=$(psql_q "select current_seat from games where id='$GAME_ID';")
seat_uid=$(psql_q "select user_id from game_players where game_id='$GAME_ID' and seat=$current_seat;")
seat_idx=0
for i in 1 2 3 4; do
  if [[ "${UID[$i]}" == "$seat_uid" ]]; then seat_idx=$i; fi
done
echo "first bidder: seat=$current_seat (P$seat_idx)"

resp=$(call "${JWT[$seat_idx]}" euchre-bid-action "{\"game_id\":\"$GAME_ID\",\"action\":\"order_up\"}")
echo "order_up: $(echo "$resp" | jq -c .)"

# Now phase=discard, dealer's turn.
dealer=$(psql_q "select dealer_seat from euchre_games where game_id='$GAME_ID';")
dealer_uid=$(psql_q "select user_id from game_players where game_id='$GAME_ID' and seat=$dealer;")
dealer_idx=0
for i in 1 2 3 4; do
  if [[ "${UID[$i]}" == "$dealer_uid" ]]; then dealer_idx=$i; fi
done
# Pick any card from dealer's hand (the just-added upcard).
discard_card=$(psql_q "select cards[1] from game_hands where game_id='$GAME_ID' and seat=$dealer;")
resp=$(call "${JWT[$dealer_idx]}" euchre-discard "{\"game_id\":\"$GAME_ID\",\"card\":\"$discard_card\"}")
echo "discard: $(echo "$resp" | jq -c .)"

# Play one card from the new current seat.
current_seat=$(psql_q "select current_seat from games where id='$GAME_ID';")
current_uid=$(psql_q "select user_id from game_players where game_id='$GAME_ID' and seat=$current_seat;")
current_idx=0
for i in 1 2 3 4; do
  if [[ "${UID[$i]}" == "$current_uid" ]]; then current_idx=$i; fi
done
play_card=$(psql_q "select cards[1] from game_hands where game_id='$GAME_ID' and seat=$current_seat;")
resp=$(call "${JWT[$current_idx]}" euchre-play-card "{\"game_id\":\"$GAME_ID\",\"card\":\"$play_card\"}")
echo "play_card seat=$current_seat card=$play_card: $(echo "$resp" | jq -c .)"

# Verify a trick row exists.
trick_count=$(psql_q "select count(*) from tricks where game_id='$GAME_ID';")
echo "tricks: $trick_count"
[[ "$trick_count" == "1" ]] || { echo "FAIL: expected 1 trick"; exit 1; }
plays_count=$(psql_q "select count(*) from trick_plays where trick_id=(select id from tricks where game_id='$GAME_ID' limit 1);")
echo "trick_plays: $plays_count"
[[ "$plays_count" == "1" ]] || { echo "FAIL: expected 1 play"; exit 1; }

echo "--- ALL SMOKE CHECKS PASSED ---"
