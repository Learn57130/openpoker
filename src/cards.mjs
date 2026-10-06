import { randomInt } from 'node:crypto';
export const RANKS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']);
export const SUITS = Object.freeze(['s', 'h', 'd', 'c']);
export const SUIT_SYMBOLS = Object.freeze({ s: '♠', h: '♥', d: '♦', c: '♣' });

export function newDeck() {
  return SUITS.flatMap(suit => RANKS.map(rank => `${rank}${suit}`));
}

export function rankValue(card) {
  const value = RANKS.indexOf(card[0]);
  if (value < 0 || !SUITS.includes(card[1]) || card.length !== 2) throw new TypeError(`Invalid card: ${card}`);
  return value + 2;
}

export function formatCard(card) {
  return `${card[0] === 'T' ? '10' : card[0]}${SUIT_SYMBOLS[card[1]]}`;
}

/** Deterministic generator so a match can be replayed from its seed. */
/**
 * A random source no player can predict, for dealing games people play. A seeded stream has about two
 * billion possible starts, so a player who sees their own cards and the flop could try every seed and
 * learn the whole deck; this one draws each number from the operating system's secure generator.
 */
export function secureRandom() {
  const span = 2 ** 48 - 1;
  return () => randomInt(0, span) / span;
}

export function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(cards, random = Math.random) {
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}
