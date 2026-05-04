-- Stale-game cleanup. The enforce-timeout sweep replaces inactive humans
-- with bots within a hand, but if every seat goes idle (everyone closed
-- their tab, or a private room never started, or a bot game was left
-- mid-hand) the games row stays in 'lobby'/'playing' forever.
--
-- This migration adds:
--   1. cleanup_stale_games() — flips lobby + playing games whose
--      updated_at is older than 1 hour to 'abandoned'.
--   2. pg_cron schedule running every 10 minutes.
--   3. admin_abandon_active_games() — admin-only RPC that nukes ALL
--      lobby/playing games right now (used by the admin page button
--      for one-shot cleanup of accumulated test games).

create or replace function public.cleanup_stale_games() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - interval '1 hour';
begin
  update public.games
  set status = 'abandoned',
      current_seat = null,
      turn_deadline = null
  where status in ('lobby', 'playing')
    and updated_at < cutoff;
end;
$$;

revoke all on function public.cleanup_stale_games() from public;

select cron.schedule(
  'cleanup-stale-games',
  '*/10 * * * *',
  $$select public.cleanup_stale_games()$$
);

create or replace function public.admin_abandon_active_games() returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean;
  affected int := 0;
begin
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and username = 'nellyfir30'
  ) into is_admin;
  if not is_admin then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  with abandoned as (
    update public.games
    set status = 'abandoned',
        current_seat = null,
        turn_deadline = null
    where status in ('lobby', 'playing')
    returning 1
  )
  select count(*) into affected from abandoned;

  return affected;
end;
$$;

revoke all on function public.admin_abandon_active_games() from public;
grant execute on function public.admin_abandon_active_games() to authenticated;
