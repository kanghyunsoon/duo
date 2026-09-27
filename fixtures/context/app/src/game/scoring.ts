/** Match scoring and ranking. */
export interface PlayerScore {
  playerId: string;
  kills: number;
  deaths: number;
  assists: number;
  objectives: number;
}

export const WEIGHTS = { kills: 100, deaths: -50, assists: 40, objectives: 150 } as const;

export function points(score: PlayerScore): number {
  return score.kills * WEIGHTS.kills + score.deaths * WEIGHTS.deaths + score.assists * WEIGHTS.assists + score.objectives * WEIGHTS.objectives;
}

/** Ranks players by points, then fewer deaths, then player id. */
export function rank(scores: readonly PlayerScore[]): PlayerScore[] {
  return [...scores].sort((a, b) => points(b) - points(a) || a.deaths - b.deaths || a.playerId.localeCompare(b.playerId));
}

/** Elo update for a two-team result. */
export function elo(ratingA: number, ratingB: number, scoreA: 0 | 0.5 | 1, k = 32): [number, number] {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  const deltaA = k * (scoreA - expectedA);
  return [Math.round(ratingA + deltaA), Math.round(ratingB - deltaA)];
}

/** Average team rating used by the matchmaker for balancing. */
export function teamRating(ratings: readonly number[]): number {
  return ratings.length === 0 ? 0 : ratings.reduce((a, b) => a + b, 0) / ratings.length;
}

/** Most valuable player: highest points; ties broken by objectives. */
export function mvp(scores: readonly PlayerScore[]): PlayerScore | undefined {
  return [...scores].sort((a, b) => points(b) - points(a) || b.objectives - a.objectives)[0];
}

/** Season leaderboard: sums scores per player over many matches. */
export function leaderboard(matches: readonly (readonly PlayerScore[])[]): { playerId: string; total: number }[] {
  const totals = new Map<string, number>();
  for (const match of matches) for (const s of match) totals.set(s.playerId, (totals.get(s.playerId) ?? 0) + points(s));
  return [...totals].map(([playerId, total]) => ({ playerId, total })).sort((a, b) => b.total - a.total || a.playerId.localeCompare(b.playerId));
}
