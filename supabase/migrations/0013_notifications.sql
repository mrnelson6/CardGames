-- Generic per-user notifications. Used for things like "your invite was
-- declined" — anything where the server (or another user via an Edge
-- Function) needs to deliver a one-shot toast to a specific user.
--
-- Recipient (user_id) can read + delete their own. Service-role inserts.

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index notifications_user_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

create policy notifications_select on public.notifications
  for select to authenticated using (auth.uid() = user_id);

create policy notifications_delete on public.notifications
  for delete to authenticated using (auth.uid() = user_id);

alter publication supabase_realtime add table public.notifications;
