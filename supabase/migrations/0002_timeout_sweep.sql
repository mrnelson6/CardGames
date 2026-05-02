-- Phase 3: pg_cron sweep that fires the enforce-timeout-sweep Edge Function
-- every 10 seconds. Catches abandoned tables when every client has dropped.
--
-- Per-environment configuration. Two secrets must live in supabase_vault.secrets:
--   - supabase_functions_url   = 'http://kong:8000' (local) or 'https://<ref>.supabase.co'
--   - supabase_service_role_key = '<service_role_key>'
--
-- For local dev, run scripts/setup_cron_secrets.sh after `supabase start`.
-- For cloud, run the equivalent SQL via the Supabase SQL editor (one-time):
--   select vault.create_secret('https://<ref>.supabase.co', 'supabase_functions_url');
--   select vault.create_secret('<service_role_key>',         'supabase_service_role_key');
-- If either secret is missing, the cron job is a no-op (game still works,
-- just no abandoned-table sweep).

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- Helper: read a vault secret by name; returns NULL if missing.
create or replace function public.read_secret(name text) returns text
language sql stable security definer set search_path = vault, public as $$
  select decrypted_secret
    from vault.decrypted_secrets
   where name = $1
   limit 1;
$$;
revoke all on function public.read_secret(text) from public;

create or replace function public.fire_enforce_timeout_sweep() returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
  url   text;
  key   text;
  stale int;
begin
  -- Cheap pre-check: skip entirely if no abandoned tables.
  select count(*) into stale
    from public.games
   where status = 'playing'
     and turn_deadline < now() - interval '5 seconds';
  if stale = 0 then return; end if;

  url := public.read_secret('supabase_functions_url');
  key := public.read_secret('supabase_service_role_key');
  if url is null or key is null then
    -- Misconfigured environment — silently no-op.
    return;
  end if;

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

-- Schedule: pg_cron supports interval syntax for sub-minute schedules.
select cron.schedule(
  'enforce-timeout-sweep',
  '10 seconds',
  $$select public.fire_enforce_timeout_sweep()$$
);
