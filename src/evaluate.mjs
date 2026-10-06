import { rankValue } from './cards.mjs';

export const HAND_NAMES = Object.freeze([
  'high card', 'one pair', 'two pair', 'three of a kind', 'straight', 'flush', 'full house', 'four of a kind', 'straight flush'
]);

// Highest card of the best straight in a set of rank values, or 0. The ace also plays low (A-2-3-4-5).
function straightHigh(values) {
  const present = new Set(values);
  if (present.has(14)) present.add(1);
  for (let high = 14; high >= 5; high -= 1) {
    let run = true;
    for (let offset = 0; offset < 5; offset += 1) {
      if (!present.has(high - offset)) {
        run = false;
        break;
      }
    }
    if (run) return high;
  }
  return 0;
}

function result(category, tiebreak) {
  const padded = [...tiebreak, 0, 0, 0, 0, 0].slice(0, 5);
  return { category, name: HAND_NAMES[category], tiebreak: padded, score: padded.reduce((total, value) => total * 15 + value, category) };
}

/** Best five-card hand from five to seven cards. A higher `score` wins; equal scores tie. */
export function evaluateHand(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) throw new TypeError('evaluateHand needs five to seven cards');
  if (new Set(cards).size !== cards.length) throw new TypeError('evaluateHand received a duplicate card');
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const bySuit = {};
  for (const card of cards) (bySuit[card[1]] ||= []).push(rankValue(card));
  const flushValues = Object.values(bySuit).find(suited => suited.length >= 5)?.sort((a, b) => b - a);

  if (flushValues) {
    const high = straightHigh(flushValues);
    if (high) return result(8, [high]);
  }

  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  // Groups ordered by size, then rank: [[rank, count], ...]
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const kickers = (excluded, needed) => values.filter(value => !excluded.includes(value)).slice(0, needed);

  if (groups[0][1] === 4) return result(7, [groups[0][0], ...kickers([groups[0][0]], 1)]);
  if (groups[0][1] === 3 && groups[1]?.[1] >= 2) return result(6, [groups[0][0], groups[1][0]]);
  if (flushValues) return result(5, flushValues.slice(0, 5));
  const high = straightHigh(values);
  if (high) return result(4, [high]);
  if (groups[0][1] === 3) return result(3, [groups[0][0], ...kickers([groups[0][0]], 2)]);
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const pairs = [groups[0][0], groups[1][0]];
    return result(2, [...pairs, ...kickers(pairs, 1)]);
  }
  if (groups[0][1] === 2) return result(1, [groups[0][0], ...kickers([groups[0][0]], 3)]);
  return result(0, values.slice(0, 5));
}

/** Positive when the first hand wins, negative when the second wins, zero on a tie. */
export function compareHands(first, second) {
  return evaluateHand(first).score - evaluateHand(second).score;
}
