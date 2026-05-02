-- Phase 4: matchmaking + ELO. Adds the `mode` column to games (nullable —
-- room-code games stay unranked), schedules a 3-second cron that POSTs to the
-- mm-tick Edge Function. Reuses the vault secrets set by 0002.

alter table public.games
  add column if not exists mode text;

create index if not exists games_mm_idx on public.games (game, mode, status)
  where mode is not null;

create or replace function public.fire_mm_tick() returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
  url    text;
  key    text;
  queued int;
begin
  -- Cheap pre-check: skip the HTTP call if no one is queued.
  select count(*) into queued from public.mm_queue;
  if queued = 0 then return; end if;

  url := public.read_secret('supabase_functions_url');
  key := public.read_secret('supabase_service_role_key');
  if url is null or key is null then return; end if;

  perform net.http_post(
    url     := rtrim(url, '/') || '/functions/v1/mm-tick',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || key
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
end;
$$;

select cron.schedule(
  'mm-tick',
  '3 seconds',
  $$select public.fire_mm_tick()$$
);
