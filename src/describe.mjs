import { rankValue } from './cards.mjs';
import { estimateEquity } from './equity.mjs';
import { evaluateHand } from './evaluate.mjs';

const STREET_WORDS = Object.freeze({
  preflop: 'before the flop (first betting round)',
  flop: 'flop (second betting round)',
  turn: 'turn (third betting round)',
  river: 'river (last betting round)'
});

const RAISE_LABELS = new Set(['raise_small', 'raise_large', 'all_in']);
const RAISE_DISCOUNT = 0.08;
const MAX_DISCOUNTED_RAISES = 3;

function strengthWord(equity) {
  if (equity < 0.35) return 'very weak';
  if (equity < 0.5) return 'weak';
  if (equity < 0.62) return 'medium';
  if (equity < 0.78) return 'strong';
  return 'very strong';
}

function priceWord(toCall, potOdds) {
  if (toCall === 0) return 'free, nothing to call';
  if (potOdds < 0.2) return 'cheap';
  if (potOdds < 0.33) return 'fair';
  if (potOdds < 0.45) return 'expensive';
  return 'very expensive';
}

function callValueWord(toCall, margin) {
  if (toCall === 0) return 'not applicable, nothing to call';
  if (margin > 0.15) return 'clearly worth it';
  if (margin > 0.03) return 'slightly worth it';
  if (margin > -0.05) return 'about break-even';
  return 'not worth it';
}

function madeHandWord(view) {
  if (view.board.length >= 3) return evaluateHand([...view.hole_cards, ...view.board]).name;
  const [first, second] = view.hole_cards;
  if (first[0] === second[0]) return 'pocket pair';
  const suited = first[1] === second[1] ? 'suited' : 'unsuited';
  const high = Math.max(rankValue(first), rankValue(second)) >= 11 ? 'with a high card' : 'with low cards';
  return `no pair yet, two ${suited} cards ${high}`;
}

// Whether this seat acts first, last or in between among the players who can still bet this round.
function positionWord(view, multiway) {
  if (!multiway) {
    const actsLast = view.street === 'preflop' ? !view.is_button : view.is_button;
    return actsLast ? 'I act last in this round' : 'I act first in this round';
  }
  const seats = view.seats;
  const button = view.is_button ? view.seat : view.opponents.find(opponent => opponent.is_button)?.seat ?? view.seat;
  // After the flop the order runs clockwise from the seat left of the button, so the button is last.
  const order = Array.from({ length: seats }, (_, step) => (button + 1 + step) % seats);
  const live = order.filter(seat => seat === view.seat || view.opponents.some(opponent => opponent.seat === seat && opponent.in_hand && !opponent.all_in));
  const index = live.indexOf(view.seat);
  if (view.street === 'preflop') {
    if (view.position === 'big blind') return 'I act last in this round';
    if (view.position === 'small blind') return 'I act near the end of this round';
  }
  if (index === live.length - 1) return 'I act last in this round';
  return index === 0 ? 'I act first in this round' : 'I act in the middle of this round';
}

function stackWord(view) {
  const bigBlinds = Math.min(view.stack, view.opponent_stack) / view.big_blind;
  if (bigBlinds < 15) return 'short';
  if (bigBlinds < 50) return 'medium';
  return 'deep';
}

const ACTION_WORDS = Object.freeze({
  check: 'checked',
  call: 'called',
  raise_small: 'made a small raise',
  raise_large: 'made a large raise',
  all_in: 'bet all of their chips'
});
const ACTION_WEIGHT = Object.freeze({ fold: 0, check: 1, call: 2, raise_small: 3, raise_large: 4, all_in: 5 });
const COUNT_WORDS = Object.freeze(['none', 'one', 'two', 'three', 'four', 'five']);

// The most aggressive thing any opponent has done in this betting round.
function opponentThisRound(view) {
  const theirs = view.actions.filter(action => action.seat !== view.seat && action.street === view.street && action.label !== 'fold');
  if (!theirs.length) return view.street === 'preflop' && view.to_call > 0 ? 'posted the big blind only' : 'has not acted yet';
  const strongest = theirs.reduce((best, action) => (ACTION_WEIGHT[action.label] >= ACTION_WEIGHT[best.label] ? action : best));
  return ACTION_WORDS[strongest.label] || 'has not acted yet';
}

// Whose habits matter most: the last opponent to raise in this hand, if they are still in it.
function relevantProfile(view, opponentProfiles, fallback) {
  if (!opponentProfiles) return fallback;
  const live = new Set((view.opponents || []).filter(opponent => opponent.in_hand).map(opponent => opponent.seat));
  const lastRaise = [...view.actions].reverse().find(action => action.seat !== view.seat && live.has(action.seat) && RAISE_LABELS.has(action.label));
  const seat = lastRaise?.seat ?? [...live][0];
  return opponentProfiles[seat] ?? fallback;
}

/** Observed tendencies in words. Too few observations are reported as unknown rather than guessed. */
export function describeOpponentProfile(profile = {}) {
  const facedRaises = Number(profile.faced_raises || 0);
  const decisions = Number(profile.decisions || 0);
  let whenRaised = 'not enough hands to tell';
  if (facedRaises >= 6) {
    const foldRate = Number(profile.folds_to_raise || 0) / facedRaises;
    whenRaised = foldRate > 0.6 ? 'folds often' : (foldRate < 0.25 ? 'rarely folds' : 'sometimes folds');
  }
  let raising = 'not enough hands to tell';
  if (decisions >= 12) {
    const raiseRate = Number(profile.raises || 0) / decisions;
    raising = raiseRate > 0.4 ? 'raises very often' : (raiseRate < 0.12 ? 'rarely raises' : 'raises a normal amount');
  }
  return { when_raised: whenRaised, how_often_they_raise: raising };
}

/**
 * Turn one seat's view into the words Jev sees (`state`) and the numbers code uses (`facts`).
 * Code does every calculation here; `state` holds no card codes and no chip counts.
 */
export function describeSituation(view, { random = Math.random, iterations = 400, opponentProfile, opponentProfiles } = {}) {
  const opponentsIn = Math.max(1, (view.players_in_hand ?? 2) - 1);
  const winChance = estimateEquity(view.hole_cards, view.board, { iterations, random, opponents: opponentsIn });
  // Strength on a two-player scale: against K opponents a hand that beats each with chance p wins
  // about p^K of the time, so the K-th root recovers p and the thresholds keep their meaning.
  const rawEquity = winChance ** (1 / opponentsIn);
  // The estimate assumes random opposing hands. An opponent who has raised holds better than
  // random on average, so each raise against this seat in the hand discounts the estimate.
  const opponentRaises = view.actions.filter(action => action.seat !== view.seat && RAISE_LABELS.has(action.label)).length;
  const discount = RAISE_DISCOUNT * Math.min(opponentRaises, MAX_DISCOUNTED_RAISES);
  const equity = Math.max(0, rawEquity - discount);
  const potOdds = view.to_call > 0 ? view.to_call / (view.pot + view.to_call) : 0;
  // Calling is judged against the real chance of winning the whole pot.
  const margin = Math.max(0, winChance - discount) - potOdds;
  const multiway = (view.players_dealt_in ?? 2) > 2;
  const state = {
    game: multiway ? 'poker at a table of several players, my turn to act' : 'two-player poker, my turn to act',
    betting_round: STREET_WORDS[view.street],
    my_hand_strength: strengthWord(equity),
    my_made_hand: madeHandWord(view),
    price_to_call: priceWord(view.to_call, potOdds),
    calling_on_the_numbers: callValueWord(view.to_call, margin),
    my_position: positionWord(view, multiway),
    stack_depth: stackWord(view),
    opponent_this_round: opponentThisRound(view),
    opponent_tendencies: describeOpponentProfile(relevantProfile(view, opponentProfiles, opponentProfile))
  };
  if (multiway) {
    const raisesThisRound = view.actions.filter(action => action.seat !== view.seat && action.street === view.street && RAISE_LABELS.has(action.label)).length;
    state.opponents_still_in = COUNT_WORDS[opponentsIn];
    state.raises_this_round = COUNT_WORDS[Math.min(raisesThisRound, 5)];
  }
  return {
    facts: { equity, raw_equity: rawEquity, win_chance: winChance, opponents_in: opponentsIn, opponent_raises: opponentRaises, pot_odds: potOdds, margin, to_call: view.to_call, pot: view.pot },
    state
  };
}
