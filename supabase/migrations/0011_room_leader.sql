-- Private rooms get an explicit leader. Until now the convention was that
-- whoever sat at seat 0 was the creator, but adding seat-rearrangement
-- means the leader role needs to survive seat shuffles.

alter table public.games
  add column leader_id uuid references auth.users(id) on delete set null;

create index games_leader_id_idx on public.games (leader_id)
  where leader_id is not null;

-- Backfill: set leader_id = seat-0 user for existing rows so older lobby
-- games keep working with the new logic.
update public.games g
set leader_id = sp.user_id
from public.game_players sp
where sp.game_id = g.id
  and sp.seat = 0
  and sp.user_id is not null
  and g.leader_id is null;
