-- Phase 5+: friend → game invitations.
-- A row is created when one player invites a friend to a private room they
-- just created. The invitee subscribes to game_invites filtered by their
-- own user_id and gets an on-screen notification. Accepting joins the game
-- (and deletes the row); declining just deletes the row.

create table public.game_invites (
  id          uuid primary key default gen_random_uuid(),
  from_user   uuid not null references auth.users(id) on delete cascade,
  to_user     uuid not null references auth.users(id) on delete cascade,
  game_id     uuid not null references public.games(id) on delete cascade,
  invite_code text not null,                 -- denormalized for client convenience
  created_at  timestamptz not null default now(),
  unique (from_user, to_user, game_id)
);

create index game_invites_to_user_idx on public.game_invites (to_user, created_at desc);

alter table public.game_invites enable row level security;

-- Recipient can see + delete their own invites. Sender can see invites
-- they've sent (so the UI can reflect state). Service-role inserts.
create policy game_invites_select on public.game_invites
  for select to authenticated using (auth.uid() in (from_user, to_user));
create policy game_invites_delete on public.game_invites
  for delete to authenticated using (auth.uid() in (from_user, to_user));

alter publication supabase_realtime add table public.game_invites;
