-- Phase 5: enable solo-vs-bots games.
-- Bots have user_id = NULL on game_players (the schema already allowed this
-- — the column is a nullable FK). They also need rows in game_hands so the
-- bot rule engine can read+mutate their cards. Drop NOT NULL on
-- game_hands.user_id; the existing RLS policy `auth.uid() = user_id` still
-- gives correct results: NULL is never equal to an authenticated uid, so a
-- human player simply cannot read a bot hand. Service-role (Edge Functions)
-- still bypasses RLS as before.

alter table public.game_hands alter column user_id drop not null;
