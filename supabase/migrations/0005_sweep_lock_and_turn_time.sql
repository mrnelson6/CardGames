-- Phase 5 polish:
-- 1) Wrap the timeout-sweep dispatcher in pg_try_advisory_xact_lock so two
--    concurrent pg_cron firings (or a slow previous tick still in flight)
--    can't both POST to enforce-timeout-sweep against the same project.
--    Without this, two sweeps can race on the same game and double-increment
--    missed_turns across seats — causing the "next player flagged as bot
--    immediately" symptom.

create or replace function public.fire_enforce_timeout_sweep() returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
  url   text;
  key   text;
  stale int;
  -- Arbitrary stable key for the advisory lock. Any constant works as long as
  -- nothing else in the schema reuses the same number.
  lock_key constant bigint := 0xC4D54157;
begin
  if not pg_try_advisory_xact_lock(lock_key) then
    -- Another sweep is already running; bail without firing a duplicate.
    return;
  end if;

  select count(*) into stale
    from public.games
   where status = 'playing'
     and turn_deadline < now() - interval '5 seconds';
  if stale = 0 then return; end if;

  url := public.read_secret('supabase_functions_url');
  key := public.read_secret('supabase_service_role_key');
  if url is null or key is null then return; end if;

  perform net.http_post(
    url     := rtrim(url, '/') || '/functions/v1/enforce-timeout-sweep',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || key
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
end;
$$;
