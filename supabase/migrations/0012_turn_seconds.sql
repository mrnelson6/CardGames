-- Per-game turn time limit. The leader of a private room picks this when
-- starting; matchmade and bot games keep the default. NULL = no limit
-- (turn_deadline is never set, the sweeper never times anyone out).

alter table public.games
  add column turn_seconds int default 45;

comment on column public.games.turn_seconds is
  'Seconds per turn; NULL means no time limit (deadlines never get set).';
