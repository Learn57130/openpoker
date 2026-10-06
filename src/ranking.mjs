export const START_RATING = 1000;
export const RATING_K = 32;

/**
 * Rating changes for one match. Each player is compared with every other player: a better
 * result than a higher-rated opponent earns more than a better result than a lower-rated one.
 * `score` is what the match is judged on (chips won); ties share. Changes are rounded to whole
 * points.
 */
export function ratingChanges(players, k = RATING_K) {
  if (players.length < 2) return players.map(() => 0);
  return players.map((player, index) => {
    let total = 0;
    players.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      const expected = 1 / (1 + 10 ** ((other.rating - player.rating) / 400));
      const actual = player.score > other.score ? 1 : (player.score === other.score ? 0.5 : 0);
      total += actual - expected;
    });
    return Math.round((k * total) / (players.length - 1));
  });
}

/** 1 for the best score; equal scores share a place. */
export function places(scores) {
  return scores.map(score => 1 + scores.filter(other => other > score).length);
}
