-- Admin dashboard. SECURITY DEFINER so it can read across tables that
-- RLS otherwise hides (auth.users counts, all profiles, all games).
-- Authorization is hardcoded to a single username — change it here if
-- the admin account is ever renamed.

create or replace function public.admin_stats() returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  is_admin boolean;
  result jsonb;
begin
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and username = 'nellyfir30'
  ) into is_admin;
  if not is_admin then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  with
    -- Live counts
    active_total as (
      select count(*)::int as n from public.games where status = 'playing'
    ),
    active_by_game as (
      select coalesce(jsonb_object_agg(game, n), '{}'::jsonb) as o
      from (
        select game, count(*)::int as n
        from public.games
        where status = 'playing'
        group by game
      ) s
    ),
    active_by_mode as (
      select coalesce(jsonb_object_agg(coalesce(mode, 'casual'), n), '{}'::jsonb) as o
      from (
        select mode, count(*)::int as n
        from public.games
        where status = 'playing'
        group by mode
      ) s
    ),
    lobby_total as (
      select count(*)::int as n from public.games where status = 'lobby'
    ),
    finished_total as (
      select count(*)::int as n from public.games where status = 'finished'
    ),
    abandoned_total as (
      select count(*)::int as n from public.games where status = 'abandoned'
    ),
    finished_by_game as (
      select coalesce(jsonb_object_agg(game, n), '{}'::jsonb) as o
      from (
        select game, count(*)::int as n
        from public.games
        where status = 'finished'
        group by game
      ) s
    ),
    -- Users
    user_total as (
      select count(*)::int as n from public.profiles
    ),
    users_24h as (
      select count(*)::int as n from public.profiles where created_at > now() - interval '24 hours'
    ),
    users_7d as (
      select count(*)::int as n from public.profiles where created_at > now() - interval '7 days'
    ),
    -- Parties / mm
    party_total as (
      select count(*)::int as n from public.parties
    ),
    mm_total as (
      select count(*)::int as n from public.mm_queue
    ),
    -- Lifetime gameplay totals (computed from game_actions / tricks)
    hands_total as (
      select count(*)::int as n from public.game_actions where action_type = 'hand_complete'
    ),
    tricks_total as (
      select count(*)::int as n from public.tricks where winner_seat is not null
    ),
    ranked_games as (
      select count(distinct game_id)::int as n from public.elo_history
    ),
    -- Active games detail
    active_games_detail as (
      select coalesce(jsonb_agg(row), '[]'::jsonb) as o
      from (
        select jsonb_build_object(
          'id',           g.id,
          'game',         g.game,
          'mode',         g.mode,
          'team0_score',  g.team0_score,
          'team1_score',  g.team1_score,
          'created_at',   g.created_at,
          'updated_at',   g.updated_at,
          'players',      (
            select coalesce(jsonb_agg(jsonb_build_object(
              'seat',     gp.seat,
              'is_bot',   gp.is_bot,
              'username', p.username
            ) order by gp.seat), '[]'::jsonb)
            from public.game_players gp
            left join public.profiles p on p.user_id = gp.user_id
            where gp.game_id = g.id
          )
        ) as row
        from public.games g
        where g.status = 'playing'
        order by g.updated_at desc
        limit 25
      ) sub
    ),
    -- Top rated players per (game, mode)
    top_ratings as (
      select coalesce(jsonb_agg(row), '[]'::jsonb) as o
      from (
        select jsonb_build_object(
          'game',         r.game,
          'mode',         r.mode,
          'username',     p.username,
          'elo',          r.elo,
          'games_played', r.games_played
        ) as row
        from public.ratings r
        join public.profiles p on p.user_id = r.user_id
        where r.games_played >= 1
        order by r.elo desc
        limit 10
      ) sub
    ),
    -- Last 10 finished games
    recent_finished as (
      select coalesce(jsonb_agg(row), '[]'::jsonb) as o
      from (
        select jsonb_build_object(
          'id',          g.id,
          'game',        g.game,
          'mode',        g.mode,
          'team0_score', g.team0_score,
          'team1_score', g.team1_score,
          'updated_at',  g.updated_at
        ) as row
        from public.games g
        where g.status = 'finished'
        order by g.updated_at desc
        limit 10
      ) sub
    ),
    -- Last 10 signups
    recent_users as (
      select coalesce(jsonb_agg(row), '[]'::jsonb) as o
      from (
        select jsonb_build_object(
          'username',   p.username,
          'created_at', p.created_at
        ) as row
        from public.profiles p
        order by p.created_at desc
        limit 10
      ) sub
    )
  select jsonb_build_object(
    'generated_at',         now(),
    'active_games',         (select n from active_total),
    'active_by_game',       (select o from active_by_game),
    'active_by_mode',       (select o from active_by_mode),
    'lobby_games',          (select n from lobby_total),
    'finished_games',       (select n from finished_total),
    'abandoned_games',      (select n from abandoned_total),
    'finished_by_game',     (select o from finished_by_game),
    'total_users',          (select n from user_total),
    'new_users_24h',        (select n from users_24h),
    'new_users_7d',         (select n from users_7d),
    'active_parties',       (select n from party_total),
    'matchmaking_queue',    (select n from mm_total),
    'total_hands_played',   (select n from hands_total),
    'total_tricks',         (select n from tricks_total),
    'ranked_games_played',  (select n from ranked_games),
    'active_games_detail',  (select o from active_games_detail),
    'top_ratings',          (select o from top_ratings),
    'recent_finished',      (select o from recent_finished),
    'recent_users',         (select o from recent_users)
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_stats() from public;
grant execute on function public.admin_stats() to authenticated;
