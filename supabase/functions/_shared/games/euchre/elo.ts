// ELO update applied when a ranked (matchmade) game ends.
// Unranked private-room games (mode IS NULL) skip this entirely.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { applyEloUpdate, type Team, teamOf } from './euchre.ts';
import type { FullGame, PlayerRow } from './state.ts';

const DEFAULT_RATING = 1000;

interface RatingSnapshot {
  user_id: string;
  game: string;
  mode: string;
  elo: number;
  games_played: number;
}

export async function applyEloOnGameEnd(
  admin: SupabaseClient,
  game: FullGame,
  players: PlayerRow[],
  winningTeam: Team,
): Promise<void> {
  if (game.mode === null) return; // unranked
  const ranked = players.filter((p) => p.user_id !== null && !p.is_bot);
  if (ranked.length === 0) return;

  // Load current ratings.
  const ids = ranked.map((p) => p.user_id!) as string[];
  const { data: existing, error: rErr } = await admin
    .from('ratings')
    .select('user_id, elo, games_played')
    .eq('game', game.game)
    .eq('mode', game.mode)
    .in('user_id', ids);
  if (rErr) {
    console.error('elo: failed to load ratings', rErr);
    return;
  }

  const ratings = new Map<string, RatingSnapshot>();
  for (const id of ids) {
    const row = (existing ?? []).find((r) => r.user_id === id);
    ratings.set(id, {
      user_id: id,
      game: game.game,
      mode: game.mode,
      elo: row?.elo ?? DEFAULT_RATING,
      games_played: row?.games_played ?? 0,
    });
  }

  // Per-team avg ratings (only counting humans who'll get an ELO change;
  // bots have user_id but we excluded them above. Fold bots in if any seat is
  // human + their teammate is bot — keep team-avg sane by including the
  // teammate's seed rating).
  const teamRatings: Record<Team, number[]> = { 0: [], 1: [] };
  for (const p of players) {
    if (p.user_id === null) continue;
    const r = ratings.get(p.user_id)?.elo ?? DEFAULT_RATING;
    teamRatings[teamOf(p.seat as 0 | 1 | 2 | 3)].push(r);
  }
  const avg = (xs: number[]): number =>
    xs.length === 0 ? DEFAULT_RATING : xs.reduce((s, n) => s + n, 0) / xs.length;
  const teamAvg: Record<Team, number> = { 0: avg(teamRatings[0]), 1: avg(teamRatings[1]) };

  for (const p of ranked) {
    const r = ratings.get(p.user_id!)!;
    const myTeam = teamOf(p.seat as 0 | 1 | 2 | 3);
    const oppTeam = (1 - myTeam) as Team;
    const won = myTeam === winningTeam;
    const newRating = applyEloUpdate(
      { rating: r.elo, gamesPlayed: r.games_played },
      teamAvg[oppTeam],
      won,
    );
    const delta = newRating - r.elo;

    // Upsert rating + bump games_played.
    const upd = await admin
      .from('ratings')
      .upsert(
        {
          user_id: r.user_id,
          game: r.game,
          mode: r.mode,
          elo: newRating,
          games_played: r.games_played + 1,
        },
        { onConflict: 'user_id,game,mode' },
      );
    if (upd.error) console.error('elo upsert failed', upd.error);

    await admin.from('elo_history').insert({
      user_id: r.user_id,
      game: r.game,
      mode: r.mode,
      game_id: game.id,
      rating_before: r.elo,
      rating_after: newRating,
      delta,
    });
  }
}
