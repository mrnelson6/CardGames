-- Pending party invitations. Mirror of game_invites: a row exists from
-- the moment a leader hits "Invite to party" until the friend either
-- accepts (row consumed, party_members inserted) or declines (row
-- deleted via RLS).

create table public.party_invites (
  id          uuid primary key default gen_random_uuid(),
  from_user   uuid not null references auth.users(id) on delete cascade,
  to_user     uuid not null references auth.users(id) on delete cascade,
  party_id    uuid not null references public.parties(id) on delete cascade,
  invite_code text not null,
  created_at  timestamptz not null default now(),
  unique (from_user, to_user, party_id)
);

create index party_invites_to_user_idx on public.party_invites (to_user, created_at desc);

alter table public.party_invites enable row level security;

create policy party_invites_select on public.party_invites
  for select to authenticated using (auth.uid() in (from_user, to_user));
create policy party_invites_delete on public.party_invites
  for delete to authenticated using (auth.uid() in (from_user, to_user));

alter publication supabase_realtime add table public.party_invites;
