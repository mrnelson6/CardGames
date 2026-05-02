-- Phase 5: friendships RPC.
-- Accepting a friend request must atomically delete the friend_requests row
-- and insert the canonical friendships row (user_a < user_b). Doing this from
-- the client would require two trips and could leave orphan rows on a race.

create or replace function public.accept_friend_request(p_from_user uuid) returns void
language plpgsql security definer set search_path = public, auth
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not authenticated';
  end if;
  if p_from_user = me then
    raise exception 'cannot friend yourself';
  end if;

  if not exists (
    select 1 from public.friend_requests
    where from_user = p_from_user and to_user = me
  ) then
    raise exception 'no such friend request';
  end if;

  insert into public.friendships (user_a, user_b)
  values (least(p_from_user, me), greatest(p_from_user, me))
  on conflict (user_a, user_b) do nothing;

  delete from public.friend_requests
  where from_user = p_from_user and to_user = me;
end;
$$;

revoke all on function public.accept_friend_request(uuid) from public;
grant execute on function public.accept_friend_request(uuid) to authenticated;

-- Realtime broadcasts so the receiver sees the request appear/disappear live.
alter publication supabase_realtime add table
  public.friend_requests,
  public.friendships;
