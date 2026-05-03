-- Lifetime stats for the profile page. One RPC that aggregates everything
-- in a single call so the client doesn't have to issue 8 round-trips.
--
-- Computed live from existing data — no backfill needed. If/when the site
-- gets enough traffic that this becomes slow, swap to a `user_stats`
-- materialized view + incremental updates from the hand_complete branch.

create or replace function public.get_user_stats(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_games_played    int := 0;
  v_games_won       int := 0;
  v_first_game_at   timestamptz;
  v_tricks_won      int := 0;
  v_total_tricks    int := 0;
  v_hands_played    int := 0;
  v_trump_called    int := 0;
  v_trump_called_set int := 0;
  v_loners_won      int := 0;
  v_marches_won     int := 0;
  v_partner_user    uuid;
  v_partner_name    text;
  v_partner_count   int;
  v_beaten_user     uuid;
  v_beaten_name     text;
  v_beaten_rating   int;
  v_fav_suit        text;
  v_fav_suit_count  int;
begin
  -- Games played + first-game timestamp.
  select count(*), min(g.created_at)
  into v_games_played, v_first_game_at
  from games g
  join game_players gp on gp.game_id = g.id
  where gp.user_id = p_user and g.status = 'finished';

  -- Games won (team reached 10 first; team = seat % 2).
  select count(*) into v_games_won
  from games g
  join game_players gp on gp.game_id = g.id
  where gp.user_id = p_user
    and g.status = 'finished'
    and (((gp.seat % 2) = 0 and g.team0_score >= 10)
      or ((gp.seat % 2) = 1 and g.team1_score >= 10));

  -- Tricks won by user (winner_seat matches their seat in that game).
  select count(*)
  into v_tricks_won
  from tricks t
  join game_players gp on gp.game_id = t.game_id and gp.seat = t.winner_seat
  where gp.user_id = p_user;

  -- Total tricks across all my games.
  select count(*)
  into v_total_tricks
  from tricks t
  where exists (
    select 1 from game_players gp
    where gp.game_id = t.game_id and gp.user_id = p_user
  );

  -- Hands played (each hand_complete is one hand).
  select count(*)
  into v_hands_played
  from game_actions ga
  where ga.action_type = 'hand_complete'
    and exists (
      select 1 from game_players gp
      where gp.game_id = ga.game_id and gp.user_id = p_user
    );

  -- Times user called trump (order_up or call_trump).
  select count(*)
  into v_trump_called
  from game_actions ga
  join game_players gp on gp.game_id = ga.game_id and gp.seat = ga.seat
  where gp.user_id = p_user
    and ga.action_type in ('order_up', 'call_trump');

  -- Times user called trump and got set: hand_complete payload says the
  -- maker_team did NOT receive the points. seat on the action row is the
  -- maker_seat (recorded in resolveHandEnd).
  select count(*)
  into v_trump_called_set
  from game_actions ga
  join game_players gp on gp.game_id = ga.game_id and gp.seat = ga.seat
  where gp.user_id = p_user
    and ga.action_type = 'hand_complete'
    and (ga.payload->>'maker_team')::int <> (ga.payload->>'points_to_team')::int;

  -- Loner hands won by user's team (only way to score 4 points).
  -- User must be on the maker_team.
  select count(*)
  into v_loners_won
  from game_actions ga
  join game_players gp on gp.game_id = ga.game_id
  where gp.user_id = p_user
    and ga.action_type = 'hand_complete'
    and (ga.payload->>'points')::int = 4
    and (gp.seat % 2) = (ga.payload->>'maker_team')::int;

  -- Marches: 5 tricks not alone => 2 points to maker_team. User on maker team.
  select count(*)
  into v_marches_won
  from game_actions ga
  join game_players gp on gp.game_id = ga.game_id
  where gp.user_id = p_user
    and ga.action_type = 'hand_complete'
    and (ga.payload->>'points')::int = 2
    and (ga.payload->>'maker_team')::int = (ga.payload->>'points_to_team')::int
    and (gp.seat % 2) = (ga.payload->>'maker_team')::int;

  -- Most played-with user (any seat, any team).
  select gp.user_id, count(*)
  into v_partner_user, v_partner_count
  from game_players gp
  where gp.user_id is not null
    and gp.user_id <> p_user
    and exists (
      select 1 from game_players me
      join games g on g.id = me.game_id
      where me.game_id = gp.game_id
        and me.user_id = p_user
        and g.status = 'finished'
    )
  group by gp.user_id
  order by count(*) desc, gp.user_id
  limit 1;

  if v_partner_user is not null then
    select username into v_partner_name from profiles where user_id = v_partner_user;
  end if;

  -- Highest-rated opponent ever beaten in a ranked game.
  -- "Ranked" = elo_history row exists for that opponent in that game.
  with my_wins as (
    select g.id as game_id, (gp.seat % 2) as my_team
    from games g
    join game_players gp on gp.game_id = g.id
    where gp.user_id = p_user
      and g.status = 'finished'
      and (((gp.seat % 2) = 0 and g.team0_score >= 10)
        or ((gp.seat % 2) = 1 and g.team1_score >= 10))
  )
  select eh.user_id, eh.rating_before
  into v_beaten_user, v_beaten_rating
  from my_wins mw
  join game_players gp on gp.game_id = mw.game_id
    and gp.user_id is not null
    and gp.user_id <> p_user
    and (gp.seat % 2) <> mw.my_team
  join elo_history eh on eh.game_id = mw.game_id and eh.user_id = gp.user_id
  order by eh.rating_before desc
  limit 1;

  if v_beaten_user is not null then
    select username into v_beaten_name from profiles where user_id = v_beaten_user;
  end if;

  -- Favorite trump suit (when user was the caller).
  select payload->>'trump', count(*)
  into v_fav_suit, v_fav_suit_count
  from game_actions ga
  join game_players gp on gp.game_id = ga.game_id and gp.seat = ga.seat
  where gp.user_id = p_user
    and ga.action_type in ('order_up', 'call_trump')
    and payload ? 'trump'
  group by payload->>'trump'
  order by count(*) desc
  limit 1;

  return jsonb_build_object(
    'games_played',       v_games_played,
    'games_won',          v_games_won,
    'first_game_at',      v_first_game_at,
    'tricks_won',         v_tricks_won,
    'total_tricks',       v_total_tricks,
    'hands_played',       v_hands_played,
    'trump_called',       v_trump_called,
    'trump_called_set',   v_trump_called_set,
    'loners_won',         v_loners_won,
    'marches_won',        v_marches_won,
    'most_played_with',
      case when v_partner_user is not null then
        jsonb_build_object(
          'user_id', v_partner_user,
          'username', v_partner_name,
          'games', v_partner_count
        )
      else null end,
    'highest_beaten',
      case when v_beaten_user is not null then
        jsonb_build_object(
          'user_id', v_beaten_user,
          'username', v_beaten_name,
          'rating', v_beaten_rating
        )
      else null end,
    'favorite_trump',
      case when v_fav_suit is not null then
        jsonb_build_object('suit', v_fav_suit, 'count', v_fav_suit_count)
      else null end
  );
end;
$$;

revoke all on function public.get_user_stats(uuid) from public;
grant execute on function public.get_user_stats(uuid) to authenticated;
