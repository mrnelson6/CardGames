-- Multi-game-ready schema for the card games site.
-- v1 ships Euchre; tables with a `game` discriminator and the `euchre_games`
-- side-table let later games (Spades, Hearts, ...) land without renames.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Profiles + ratings
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique
    check (char_length(username) between 3 and 24
           and username ~ '^[A-Za-z0-9_]+$'),
  avatar_url  text,
  created_at  timestamptz not null default now()
);

create table public.ratings (
  user_id      uuid not null references auth.users(id) on delete cascade,
  game         text not null,                       -- 'euchre', later 'spades', ...
  mode         text not null,                       -- 'solo', 'duo', or game-specific
  elo          int  not null default 1000,
  games_played int  not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (user_id, game, mode)
);

create index ratings_game_mode_elo_idx on public.ratings (game, mode, elo);

-- ELO history: one row per ranked game completed.
create table public.elo_history (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  game          text not null,
  mode          text not null,
  game_id       uuid not null,
  rating_before int  not null,
  rating_after  int  not null,
  delta         int  not null,
  created_at    timestamptz not null default now()
);

create index elo_history_user_idx on public.elo_history (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Friends + parties
-- ---------------------------------------------------------------------------

create table public.friend_requests (
  from_user  uuid not null references auth.users(id) on delete cascade,
  to_user    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_user, to_user),
  check (from_user <> to_user)
);

create table public.friendships (
  user_a     uuid not null references auth.users(id) on delete cascade,
  user_b     uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);

create table public.parties (
  id          uuid primary key default gen_random_uuid(),
  leader_id   uuid not null references auth.users(id) on delete cascade,
  invite_code text not null unique
    check (char_length(invite_code) = 6),
  created_at  timestamptz not null default now()
);

create table public.party_members (
  party_id  uuid not null references public.parties(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (party_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Matchmaking queue
-- ---------------------------------------------------------------------------

create table public.mm_queue (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  game              text not null,                  -- 'euchre', later 'spades', ...
  mode              text not null,                  -- 'solo', 'duo', ...
  party_id          uuid references public.parties(id) on delete cascade,
  party_size        int  not null default 1,
  rating            int  not null,
  party_avg_rating  int  not null,
  enqueued_at       timestamptz not null default now(),
  band              int  not null default 50
);

create index mm_queue_game_mode_idx on public.mm_queue (game, mode, enqueued_at);

-- ---------------------------------------------------------------------------
-- Games (slim, generic across card games)
-- ---------------------------------------------------------------------------

create type game_status as enum ('lobby', 'playing', 'finished', 'abandoned');

create table public.games (
  id            uuid primary key default gen_random_uuid(),
  status        game_status not null default 'lobby',
  game          text not null,                      -- 'euchre', later 'spades', ...
  current_seat  int,
  team0_score   int  not null default 0,
  team1_score   int  not null default 0,
  turn_deadline timestamptz,
  invite_code   text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index games_status_deadline_idx on public.games (status, turn_deadline)
  where status = 'playing';

create table public.game_players (
  game_id       uuid not null references public.games(id) on delete cascade,
  seat          int  not null check (seat between 0 and 3),
  user_id       uuid references auth.users(id) on delete set null,
  is_bot        boolean not null default false,
  missed_turns  int  not null default 0,
  primary key (game_id, seat)
);

create index game_players_user_idx on public.game_players (user_id) where user_id is not null;

-- Private hands. RLS allows select only when auth.uid() = user_id.
-- No write policies => only service_role (Edge Functions) can write.
-- discarded_card holds the dealer's discard after order-up; revealed at hand end.
create table public.game_hands (
  game_id        uuid not null references public.games(id) on delete cascade,
  seat           int  not null check (seat between 0 and 3),
  user_id        uuid not null,
  cards          text[] not null default '{}',
  discarded_card text,
  primary key (game_id, seat)
);

-- Tricks + plays (generic to trick-taking games).
create table public.tricks (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games(id) on delete cascade,
  hand_number  int  not null,
  trick_number int  not null,
  lead_seat    int  not null check (lead_seat between 0 and 3),
  winner_seat  int  check (winner_seat between 0 and 3),
  led_suit     text,
  created_at   timestamptz not null default now(),
  unique (game_id, hand_number, trick_number)
);

create table public.trick_plays (
  trick_id  uuid not null references public.tricks(id) on delete cascade,
  seat      int  not null check (seat between 0 and 3),
  card      text not null,
  played_at timestamptz not null default now(),
  primary key (trick_id, seat)
);

-- Append-only audit log (any game).
create table public.game_actions (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games(id) on delete cascade,
  seat        int,
  action_type text not null,
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index game_actions_game_idx on public.game_actions (game_id, created_at);

-- ---------------------------------------------------------------------------
-- Euchre-specific game state (1:1 with games row when game='euchre')
-- ---------------------------------------------------------------------------

create table public.euchre_games (
  game_id          uuid primary key references public.games(id) on delete cascade,
  dealer_seat      int  not null check (dealer_seat between 0 and 3),
  hand_number      int  not null default 1,
  current_trick_id uuid references public.tricks(id) on delete set null,
  trump_suit       text check (trump_suit in ('C','D','H','S')),
  maker_seat       int check (maker_seat between 0 and 3),
  alone_seat       int check (alone_seat between 0 and 3),
  upcard           text,
  upcard_status    text check (upcard_status in ('face_up','turned_down','taken'))
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Stable membership check used by RLS on games/game_players/tricks/trick_plays.
-- security definer + stable lets Postgres cache it per-statement and avoids
-- recursive RLS evaluation on Realtime broadcasts.
create or replace function public.is_in_game(p_user uuid, p_game uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.game_players
    where game_id = p_game and user_id = p_user
  );
$$;

revoke all on function public.is_in_game(uuid, uuid) from public;
grant execute on function public.is_in_game(uuid, uuid) to authenticated;

-- updated_at trigger
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger games_updated_at
  before update on public.games
  for each row execute function public.set_updated_at();

create trigger ratings_updated_at
  before update on public.ratings
  for each row execute function public.set_updated_at();

-- New auth.users row => insert a profiles row (no ratings yet; lazy on first ranked game).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base_username text;
  candidate     text;
  attempt       int := 0;
begin
  base_username := coalesce(
    nullif(regexp_replace(coalesce(new.email, ''), '@.*$', ''), ''),
    'player'
  );
  base_username := regexp_replace(base_username, '[^A-Za-z0-9_]', '', 'g');
  if char_length(base_username) < 3 then
    base_username := 'player';
  end if;
  if char_length(base_username) > 20 then
    base_username := substr(base_username, 1, 20);
  end if;

  candidate := base_username;
  while exists (select 1 from public.profiles where username = candidate) loop
    attempt := attempt + 1;
    candidate := base_username || attempt::text;
  end loop;

  insert into public.profiles (user_id, username) values (new.id, candidate);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles         enable row level security;
alter table public.ratings          enable row level security;
alter table public.elo_history      enable row level security;
alter table public.friend_requests  enable row level security;
alter table public.friendships      enable row level security;
alter table public.parties          enable row level security;
alter table public.party_members    enable row level security;
alter table public.mm_queue         enable row level security;
alter table public.games            enable row level security;
alter table public.game_players     enable row level security;
alter table public.game_hands       enable row level security;
alter table public.tricks           enable row level security;
alter table public.trick_plays      enable row level security;
alter table public.game_actions     enable row level security;
alter table public.euchre_games     enable row level security;

-- profiles: anyone signed-in can read (for usernames in lobbies); only owner can update.
create policy profiles_select on public.profiles
  for select to authenticated using (true);
create policy profiles_update_self on public.profiles
  for update to authenticated using (auth.uid() = user_id);

-- ratings: public reads (leaderboards later). Only service_role writes.
create policy ratings_select on public.ratings
  for select to authenticated using (true);

-- elo_history: owner reads only.
create policy elo_history_select_self on public.elo_history
  for select to authenticated using (auth.uid() = user_id);

-- friends: only the two users involved can see their rows.
create policy friend_requests_select on public.friend_requests
  for select to authenticated using (auth.uid() in (from_user, to_user));
create policy friend_requests_insert on public.friend_requests
  for insert to authenticated with check (auth.uid() = from_user);
create policy friend_requests_delete on public.friend_requests
  for delete to authenticated using (auth.uid() in (from_user, to_user));

create policy friendships_select on public.friendships
  for select to authenticated using (auth.uid() in (user_a, user_b));
create policy friendships_delete on public.friendships
  for delete to authenticated using (auth.uid() in (user_a, user_b));

-- parties: leader and members can read. Service-role manages writes.
create policy parties_select on public.parties
  for select to authenticated using (
    auth.uid() = leader_id
    or exists (select 1 from public.party_members pm
               where pm.party_id = id and pm.user_id = auth.uid())
  );
create policy party_members_select on public.party_members
  for select to authenticated using (
    user_id = auth.uid()
    or exists (select 1 from public.parties p
               where p.id = party_id and p.leader_id = auth.uid())
  );

-- mm_queue: owner sees own row.
create policy mm_queue_select_self on public.mm_queue
  for select to authenticated using (auth.uid() = user_id);
create policy mm_queue_delete_self on public.mm_queue
  for delete to authenticated using (auth.uid() = user_id);

-- games / game_players / tricks / trick_plays / euchre_games:
-- visible to anyone seated at the table.
create policy games_select on public.games
  for select to authenticated using (public.is_in_game(auth.uid(), id));

create policy game_players_select on public.game_players
  for select to authenticated using (public.is_in_game(auth.uid(), game_id));

create policy tricks_select on public.tricks
  for select to authenticated using (public.is_in_game(auth.uid(), game_id));

create policy trick_plays_select on public.trick_plays
  for select to authenticated using (
    exists (select 1 from public.tricks t
            where t.id = trick_id
              and public.is_in_game(auth.uid(), t.game_id))
  );

create policy euchre_games_select on public.euchre_games
  for select to authenticated using (public.is_in_game(auth.uid(), game_id));

create policy game_actions_select on public.game_actions
  for select to authenticated using (public.is_in_game(auth.uid(), game_id));

-- game_hands: owner-only select. NO insert/update/delete policy => service_role only.
create policy game_hands_select_own on public.game_hands
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table
  public.games,
  public.game_players,
  public.tricks,
  public.trick_plays,
  public.game_actions,
  public.euchre_games,
  public.game_hands;
