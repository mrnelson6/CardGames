-- Auto-disband single-member parties that have been sitting idle for
-- more than 30 minutes. Without this, every "Create party → never
-- invite → close browser" sequence leaves a permanent stale row that
-- later trips up `friend_in_party` when the user (or any friend that
-- might invite them) tries to start a new one.
--
-- Runs every 5 minutes via pg_cron. Cheap query — most of the time
-- there's nothing to do.

create or replace function public.cleanup_stale_parties() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - interval '30 minutes';
begin
  delete from public.parties p
  where p.created_at < cutoff
    and (
      select count(*) from public.party_members pm where pm.party_id = p.id
    ) < 2;
end;
$$;

revoke all on function public.cleanup_stale_parties() from public;

select cron.schedule(
  'cleanup-stale-parties',
  '*/5 * * * *',
  $$select public.cleanup_stale_parties()$$
);
