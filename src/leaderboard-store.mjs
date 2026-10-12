import { createPrivateJsonFile } from './lib/files.mjs';
import { places, ratingChanges, START_RATING } from './ranking.mjs';

export const LEADERBOARD_SCHEMA = 'jev/poker-leaderboard/v1';
export const LEADERBOARD_LIMITS = Object.freeze({ trend: 200 });

// What a list shows: the entry without its trend, with the skill figures worked out.
function summarize(entry, rank) {
  const { trend, ...record } = entry;
  return {
    ...record,
    rank,
    bb_per_100: entry.hands ? Number(((entry.net_big_blinds / entry.hands) * 100).toFixed(1)) : null,
    win_rate: entry.matches ? Number((entry.match_wins / entry.matches).toFixed(3)) : null,
    avg_think_ms: entry.decisions ? Math.round(entry.think_ms_total / entry.decisions) : null,
    last_played_at: trend[0]?.at ?? null
  };
}

/**
 * Ratings by player key (a type and its model, or a rule bot's style), kept in one private file.
 * Each key has a rating that moves after every match, running totals and a rating trend.
 */
export function createLeaderboardStore({ file, now = () => new Date() }) {
  const store = createPrivateJsonFile({ file, schema: LEADERBOARD_SCHEMA, invalidCode: 'LEADERBOARD_INVALID', empty: () => ({ players: [] }) });
  const ranked = players => [...players].sort((a, b) => b.rating - a.rating || a.key.localeCompare(b.key));

  return {
    async list() {
      return ranked((await store.read()).players).map((entry, index) => summarize(entry, index + 1));
    },

    async get(key) {
      const order = ranked((await store.read()).players);
      const index = order.findIndex(entry => entry.key === key);
      if (index < 0) throw Object.assign(new Error('No player has that key'), { code: 'PLAYER_NOT_FOUND' });
      return { ...summarize(order[index], index + 1), trend: order[index].trend.map(point => ({ ...point })) };
    },

    /** The current rating of each key, or the starting rating for one never seen. */
    async ratings(keys) {
      const byKey = new Map((await store.read()).players.map(entry => [entry.key, entry.rating]));
      return keys.map(key => (key ? byKey.get(key) ?? START_RATING : START_RATING));
    },

    /**
     * Record one finished match. `seats` lists every seat in order as `{ key, name, net_chips,
     * decisions, think_ms_total }`; a seat whose key is null is a guest, rated at the starting rating
     * and not stored. Each seat is rated on its own; a key with two seats moves by the sum of both.
     * Returns each seat's key rating before and after.
     */
    async recordMatch({ game = null, hands, big_blind: bigBlind, seats }) {
      return await store.change(data => {
        const byKey = new Map(data.players.map(entry => [entry.key, entry]));
        const before = seats.map(seat => (seat.key ? byKey.get(seat.key)?.rating ?? START_RATING : START_RATING));
        const scores = seats.map(seat => seat.net_chips);
        const changes = ratingChanges(before.map((rating, index) => ({ rating, score: scores[index] })));
        const finish = places(scores);
        const soleWinner = finish.filter(place => place === 1).length === 1 ? finish.indexOf(1) : -1;
        const at = now().toISOString();
        const keys = [...new Set(seats.map(seat => seat.key).filter(Boolean))];
        const after = new Map();
        for (const key of keys) {
          const mine = seats.map((seat, index) => index).filter(index => seats[index].key === key);
          let entry = byKey.get(key);
          if (!entry) {
            entry = { key, name: seats[mine[0]].name, rating: START_RATING, matches: 0, match_wins: 0, hands: 0, net_chips: 0, net_big_blinds: 0, decisions: 0, think_ms_total: 0, trend: [] };
            data.players.push(entry);
          }
          const ratingBefore = entry.rating;
          entry.name = seats[mine[0]].name;
          entry.rating += mine.reduce((total, index) => total + changes[index], 0);
          entry.matches += 1;
          if (mine.includes(soleWinner)) entry.match_wins += 1;
          // Hands are counted per seat, so big blinds per 100 hands stays a per-seat figure.
          entry.hands += hands * mine.length;
          for (const index of mine) {
            entry.net_chips += seats[index].net_chips;
            entry.net_big_blinds += seats[index].net_chips / bigBlind;
            entry.decisions += seats[index].decisions ?? 0;
            entry.think_ms_total += seats[index].think_ms_total ?? 0;
          }
          entry.trend.unshift({ at, game, rating_before: ratingBefore, rating_after: entry.rating });
          entry.trend.length = Math.min(entry.trend.length, LEADERBOARD_LIMITS.trend);
          after.set(key, entry.rating);
        }
        return seats.map((seat, index) => ({ key: seat.key, name: seat.name, before: before[index], after: seat.key ? after.get(seat.key) : before[index] }));
      });
    }
  };
}
