import { newDeck } from './cards.mjs';
import { evaluateHand } from './evaluate.mjs';

/**
 * Monte Carlo chance of winning at showdown against `opponents` random hands.
 * A tie counts as an equal share of a win. No opponent's actual cards are ever an input.
 */
export function estimateEquity(holeCards, board = [], { iterations = 400, random = Math.random, opponents = 1 } = {}) {
  if (holeCards.length !== 2 || board.length > 5) throw new TypeError('estimateEquity needs two hole cards and at most five board cards');
  if (!Number.isInteger(opponents) || opponents < 1 || opponents > 5) throw new TypeError('estimateEquity needs one to five opponents');
  const known = new Set([...holeCards, ...board]);
  const remaining = newDeck().filter(card => !known.has(card));
  const boardNeeded = 5 - board.length;
  const needed = opponents * 2 + boardNeeded;
  let won = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    // Partial Fisher-Yates: only the first `needed` positions are drawn.
    for (let index = 0; index < needed; index += 1) {
      const swap = index + Math.floor(random() * (remaining.length - index));
      [remaining[index], remaining[swap]] = [remaining[swap], remaining[index]];
    }
    const fullBoard = [...board, ...remaining.slice(opponents * 2, needed)];
    const mine = evaluateHand([...holeCards, ...fullBoard]).score;
    let tiedWith = 0;
    let beaten = false;
    for (let opponent = 0; opponent < opponents; opponent += 1) {
      const theirs = evaluateHand([remaining[opponent * 2], remaining[opponent * 2 + 1], ...fullBoard]).score;
      if (theirs > mine) {
        beaten = true;
        break;
      }
      if (theirs === mine) tiedWith += 1;
    }
    if (!beaten) won += 1 / (tiedWith + 1);
  }
  return won / iterations;
}
