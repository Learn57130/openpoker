import { newDeck, shuffle } from './cards.mjs';
import { evaluateHand } from './evaluate.mjs';

export const ACTION_LABELS = Object.freeze(['fold', 'check', 'call', 'raise_small', 'raise_large', 'all_in']);
export const STREETS = Object.freeze(['preflop', 'flop', 'turn', 'river']);
export const MAX_RAISES_PER_STREET = 4;
export const MIN_SEATS = 2;
export const MAX_SEATS = 6;

const BOARD_CARDS_BY_STREET = Object.freeze({ preflop: 0, flop: 3, turn: 4, river: 5 });

function illegal(message) {
  return Object.assign(new Error(message), { code: 'ILLEGAL_ACTION' });
}

function potOf(hand) {
  return hand.contributed.reduce((total, chips) => total + chips, 0);
}

function seatsOf(hand) {
  return hand.stacks.map((_, seat) => seat);
}

// Seats in clockwise order, starting with the seat after `from`.
function clockwiseFrom(hand, from) {
  const count = hand.stacks.length;
  return Array.from({ length: count }, (_, step) => (from + 1 + step) % count);
}

function canAct(hand, seat) {
  return hand.inHand[seat] && hand.stacks[seat] > 0;
}

function pay(hand, seat, amount) {
  hand.stacks[seat] -= amount;
  hand.committed[seat] += amount;
  hand.contributed[seat] += amount;
}

// The part of the largest bet that no other player matched goes back to the bettor.
function returnUncalled(hand) {
  const top = seatsOf(hand).reduce((best, seat) => (hand.committed[seat] > hand.committed[best] ? seat : best), 0);
  const nextHighest = Math.max(0, ...seatsOf(hand).filter(seat => seat !== top).map(seat => hand.committed[seat]));
  const excess = hand.committed[top] - nextHighest;
  if (excess > 0 && hand.inHand[top]) pay(hand, top, -excess);
}

function dealBoardTo(hand, count) {
  while (hand.board.length < count) hand.board.push(hand.deck.pop());
}

function finish(hand, { reason, payouts, pots, handNames }) {
  for (const seat of seatsOf(hand)) hand.stacks[seat] += payouts[seat];
  const net = hand.stacks.map((chips, seat) => chips - hand.startingStacks[seat]);
  // Winners are the players who took a contested pot, not those who only got an unmatched bet back.
  const winners = [...new Set(pots.filter(pot => pot.eligible.length > 1 || reason === 'fold').flatMap(pot => pot.winners))].sort((a, b) => a - b);
  hand.status = 'complete';
  hand.toAct = null;
  hand.result = {
    reason,
    winner: winners.length === 1 ? winners[0] : null,
    winners,
    pot: payouts.reduce((total, chips) => total + chips, 0),
    pots,
    payouts,
    net,
    hand_names: handNames
  };
}

function finishByFold(hand) {
  const winner = hand.inHand.indexOf(true);
  const pot = potOf(hand);
  const payouts = hand.stacks.map((_, seat) => (seat === winner ? pot : 0));
  finish(hand, { reason: 'fold', payouts, pots: [{ amount: pot, eligible: [winner], winners: [winner] }], handNames: null });
}

// Side pots: one pot per distinct contribution level, won by the best hand among those who reached it.
function showdown(hand) {
  dealBoardTo(hand, 5);
  hand.street = 'river';
  const seats = seatsOf(hand);
  const evaluated = seats.map(seat => (hand.inHand[seat] ? evaluateHand([...hand.holeCards[seat], ...hand.board]) : null));
  const remaining = [...hand.contributed];
  const payouts = seats.map(() => 0);
  const pots = [];
  const oddChipOrder = clockwiseFrom(hand, hand.button);
  while (remaining.some(chips => chips > 0)) {
    const stillOwed = seats.filter(seat => hand.inHand[seat] && remaining[seat] > 0);
    // Chips left only by folded players join the last pot.
    if (!stillOwed.length) {
      const dead = remaining.reduce((total, chips) => total + chips, 0);
      const last = pots.at(-1);
      last.amount += dead;
      payouts[oddChipOrder.find(seat => last.winners.includes(seat))] += dead;
      break;
    }
    const level = Math.min(...stillOwed.map(seat => remaining[seat]));
    let amount = 0;
    for (const seat of seats) {
      const taken = Math.min(remaining[seat], level);
      remaining[seat] -= taken;
      amount += taken;
    }
    const best = Math.max(...stillOwed.map(seat => evaluated[seat].score));
    const winners = stillOwed.filter(seat => evaluated[seat].score === best);
    const share = Math.floor(amount / winners.length);
    for (const seat of winners) payouts[seat] += share;
    let odd = amount - share * winners.length;
    for (const seat of oddChipOrder) {
      if (odd === 0) break;
      if (winners.includes(seat)) {
        payouts[seat] += 1;
        odd -= 1;
      }
    }
    pots.push({ amount, eligible: stillOwed, winners });
  }
  finish(hand, { reason: 'showdown', payouts, pots, handNames: evaluated.map(result => result?.name ?? null) });
}

// Moves the hand forward after the blinds and after every action. `from` is the seat that just acted.
function resolve(hand, from) {
  const contenders = seatsOf(hand).filter(seat => hand.inHand[seat]);
  if (contenders.length === 1) return finishByFold(hand);
  const able = contenders.filter(seat => hand.stacks[seat] > 0);
  const owes = seat => hand.committed[seat] < hand.currentBet;
  // With one player left who can bet and nothing for them to call, there is nobody to bet against.
  const waiting = able.length === 1 && !owes(able[0]) ? [] : able.filter(seat => !hand.acted[seat] || owes(seat));
  if (waiting.length) {
    hand.toAct = clockwiseFrom(hand, from).find(seat => waiting.includes(seat));
    return undefined;
  }
  returnUncalled(hand);
  if (able.length <= 1 || hand.street === 'river') return showdown(hand);
  hand.street = STREETS[STREETS.indexOf(hand.street) + 1];
  dealBoardTo(hand, BOARD_CARDS_BY_STREET[hand.street]);
  hand.committed = hand.committed.map(() => 0);
  hand.acted = hand.acted.map(() => false);
  hand.currentBet = 0;
  hand.raisesThisStreet = 0;
  hand.lastRaiseSize = hand.bigBlind;
  hand.toAct = clockwiseFrom(hand, hand.button).find(seat => canAct(hand, seat));
  return undefined;
}

/**
 * Start one hand for two to six seats. A seat with no chips sits out. With two players the button
 * posts the small blind and acts first before the flop. With more, the seat left of the button
 * posts the small blind, the next posts the big blind, and the seat after that acts first. On
 * later streets the first live seat left of the button acts first.
 */
export function startHand({ stacks, button, smallBlind = 1, bigBlind = 2, random = Math.random, handNumber = 1, deck: suppliedDeck }) {
  if (!Array.isArray(stacks) || stacks.length < MIN_SEATS || stacks.length > MAX_SEATS || stacks.some(stack => !Number.isSafeInteger(stack) || stack < 0)) {
    throw new TypeError(`startHand needs ${MIN_SEATS} to ${MAX_SEATS} non-negative integer stacks`);
  }
  const dealtIn = stacks.map(stack => stack > 0);
  if (dealtIn.filter(Boolean).length < 2) throw new TypeError('startHand needs at least two players with chips');
  if (!Number.isInteger(button) || button < 0 || button >= stacks.length || !dealtIn[button]) throw new TypeError('button must be a seat with chips');
  if (!Number.isSafeInteger(smallBlind) || !Number.isSafeInteger(bigBlind) || smallBlind < 1 || bigBlind < smallBlind) {
    throw new TypeError('blinds must be positive integers with bigBlind >= smallBlind');
  }
  if (suppliedDeck && (suppliedDeck.length !== 52 || new Set(suppliedDeck).size !== 52)) throw new TypeError('A supplied deck must hold 52 distinct cards');
  const deck = suppliedDeck ? [...suppliedDeck] : shuffle(newDeck(), random);
  const hand = {
    handNumber,
    button,
    smallBlind,
    bigBlind,
    deck,
    holeCards: stacks.map(() => null),
    board: [],
    stacks: [...stacks],
    startingStacks: [...stacks],
    inHand: dealtIn,
    dealtIn: [...dealtIn],
    committed: stacks.map(() => 0),
    contributed: stacks.map(() => 0),
    street: 'preflop',
    toAct: null,
    acted: stacks.map(() => false),
    currentBet: 0,
    lastRaiseSize: bigBlind,
    raisesThisStreet: 0,
    status: 'playing',
    actions: [],
    result: null
  };
  // Cards are dealt by position (button first) so a supplied deck can be replayed with the seats moved round.
  const dealOrder = [button, ...clockwiseFrom(hand, button).slice(0, -1)].filter(seat => dealtIn[seat]);
  for (const seat of dealOrder) hand.holeCards[seat] = [deck.pop(), deck.pop()];
  const headsUp = dealOrder.length === 2;
  hand.smallBlindSeat = headsUp ? button : dealOrder[1];
  hand.bigBlindSeat = headsUp ? dealOrder[1] : dealOrder[2];
  pay(hand, hand.smallBlindSeat, Math.min(smallBlind, hand.stacks[hand.smallBlindSeat]));
  pay(hand, hand.bigBlindSeat, Math.min(bigBlind, hand.stacks[hand.bigBlindSeat]));
  hand.currentBet = Math.max(...hand.committed);
  // The search for the first player starts after the big blind (the button itself when heads-up).
  resolve(hand, hand.bigBlindSeat);
  return hand;
}

/** Actions the seat to act may take now. `amount` is the chips added; `to` is the seat's total bet this round. */
export function legalActions(hand) {
  if (hand.status !== 'playing') return [];
  const seat = hand.toAct;
  const toCall = hand.currentBet - hand.committed[seat];
  const stack = hand.stacks[seat];
  const actions = [];
  if (toCall > 0) {
    actions.push({ label: 'fold', amount: 0, to: hand.committed[seat] });
    actions.push({ label: 'call', amount: Math.min(toCall, stack), to: hand.committed[seat] + Math.min(toCall, stack) });
  } else {
    actions.push({ label: 'check', amount: 0, to: hand.committed[seat] });
  }
  const others = seatsOf(hand).filter(other => other !== seat && hand.inHand[other]);
  const canRaise = stack > toCall && hand.raisesThisStreet < MAX_RAISES_PER_STREET && others.some(other => hand.stacks[other] > 0);
  if (!canRaise) return actions;
  // Never bet more than the largest live opponent can match.
  const maxTo = Math.min(hand.committed[seat] + stack, Math.max(...others.map(other => hand.committed[other] + hand.stacks[other])));
  if (maxTo <= hand.currentBet) return actions;
  const minTo = Math.min(maxTo, hand.currentBet + Math.max(hand.lastRaiseSize, hand.bigBlind));
  const potAfterCall = potOf(hand) + toCall;
  const clamp = target => Math.max(minTo, Math.min(maxTo, target));
  const smallTo = clamp(hand.currentBet + Math.round(potAfterCall / 2));
  const largeTo = clamp(hand.currentBet + potAfterCall);
  const raise = (label, to) => actions.push({ label, amount: to - hand.committed[seat], to });
  if (smallTo < maxTo) raise('raise_small', smallTo);
  if (largeTo < maxTo && largeTo > smallTo) raise('raise_large', largeTo);
  raise('all_in', maxTo);
  return actions;
}

export function applyAction(hand, label) {
  if (hand.status !== 'playing') throw illegal('The hand is already complete');
  const action = legalActions(hand).find(candidate => candidate.label === label);
  if (!action) throw illegal(`Action is not legal now: ${label}`);
  const seat = hand.toAct;
  hand.actions.push({ street: hand.street, seat, label, amount: action.amount, to: action.to });
  if (label === 'fold') {
    hand.inHand[seat] = false;
  } else {
    pay(hand, seat, action.amount);
    if (action.to > hand.currentBet) {
      // Any raise, including a short all-in, reopens the betting for everyone else.
      hand.lastRaiseSize = Math.max(hand.lastRaiseSize, action.to - hand.currentBet);
      hand.currentBet = action.to;
      hand.raisesThisStreet += 1;
      hand.acted = hand.acted.map(() => false);
    }
  }
  hand.acted[seat] = true;
  resolve(hand, seat);
  return hand;
}

function positionName(hand, seat) {
  if (seat === hand.button) return hand.smallBlindSeat === seat ? 'button and small blind' : 'button';
  if (seat === hand.smallBlindSeat) return 'small blind';
  return seat === hand.bigBlindSeat ? 'big blind' : 'other';
}

/** What one seat is allowed to know. Other seats' hole cards are never included. */
export function seatView(hand, seat) {
  const opponents = seatsOf(hand).filter(other => other !== seat && hand.dealtIn[other]).map(other => ({
    seat: other,
    stack: hand.stacks[other],
    committed: hand.committed[other],
    in_hand: hand.inHand[other],
    all_in: hand.inHand[other] && hand.stacks[other] === 0,
    is_button: hand.button === other
  }));
  const live = opponents.filter(opponent => opponent.in_hand);
  return {
    hand_number: hand.handNumber,
    seat,
    seats: hand.stacks.length,
    players_dealt_in: hand.dealtIn.filter(Boolean).length,
    players_in_hand: hand.inHand.filter(Boolean).length,
    in_hand: hand.inHand[seat],
    is_button: hand.button === seat,
    position: positionName(hand, seat),
    street: hand.street,
    hole_cards: hand.holeCards[seat] ? [...hand.holeCards[seat]] : [],
    board: [...hand.board],
    pot: potOf(hand),
    to_call: hand.inHand[seat] ? Math.max(0, hand.currentBet - hand.committed[seat]) : 0,
    stack: hand.stacks[seat],
    committed: hand.committed[seat],
    // The largest stack among opponents still in the hand: what a bet can actually win.
    opponent_stack: Math.max(0, ...live.map(opponent => opponent.stack)),
    opponents,
    big_blind: hand.bigBlind,
    actions: hand.actions.map(action => ({ ...action })),
    legal_actions: hand.status === 'playing' && hand.toAct === seat ? legalActions(hand) : []
  };
}

/** Public outcome. Hole cards are revealed only at showdown, and only for players who did not fold. */
export function publicResult(hand) {
  if (hand.status !== 'complete') return null;
  return {
    ...hand.result,
    board: [...hand.board],
    shown_cards: hand.result.reason === 'showdown' ? hand.holeCards.map((cards, seat) => (hand.inHand[seat] ? [...cards] : null)) : null,
    stacks: [...hand.stacks]
  };
}
