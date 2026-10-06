import { newDeck, shuffle } from './cards.mjs';
import { applyAction, MAX_SEATS, MIN_SEATS, publicResult, seatView, startHand } from './engine.mjs';

export const MATCH_LIMITS = Object.freeze({ maxHands: 500, minStack: 20, maxStack: 1_000_000, maxDecisionTimeoutMs: 600_000 });

function emptyProfile() {
  return { decisions: 0, raises: 0, faced_raises: 0, folds_to_raise: 0 };
}

function isRaise(label) {
  return label === 'raise_small' || label === 'raise_large' || label === 'all_in';
}

// Result per hand in big blinds. With duplicate deals the unit of independent evidence is the
// pair of mirrored hands, so the standard error is taken over pair averages.
function thinkStats(log, seat) {
  const times = log.flatMap(hand => hand.actions.filter(action => action.seat === seat).map(action => action.think_ms));
  if (!times.length) return { think_ms_total: 0, think_ms_mean: null, think_ms_max: null };
  const total = times.reduce((sum, value) => sum + value, 0);
  return { think_ms_total: total, think_ms_mean: Math.round(total / times.length), think_ms_max: Math.max(...times) };
}

function safeLabel(view) {
  return view.legal_actions.some(action => action.label === 'check') ? 'check' : 'fold';
}

// Runs one decision, timing it. With a limit, a player who has not answered in time is checked or
// folded and its `signal` is aborted so a slow model call can be cancelled.
async function timedDecision(player, view, context, decisionTimeoutMs, now) {
  const controller = new AbortController();
  const started = now();
  let timer = null;
  try {
    const answer = Promise.resolve(player.decide(view, { ...context, signal: controller.signal, deadline_ms: decisionTimeoutMs || null }));
    if (!decisionTimeoutMs) return { decision: await answer, think_ms: Math.round(now() - started) };
    // A late failure after the clock has already played the turn must not surface as unhandled.
    answer.catch(() => {});
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), decisionTimeoutMs);
    });
    const decision = await Promise.race([answer, timeout]);
    if (decision === null) {
      controller.abort();
      return { decision: { label: safeLabel(view), meta: { source: 'fallback', reason: 'timeout' } }, think_ms: decisionTimeoutMs };
    }
    return { decision, think_ms: Math.round(now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

function summarize(perHandNet, bigBlind, duplicate) {
  const hands = perHandNet.length;
  if (!hands) return { hands: 0, bb_per_100: null, standard_error_bb_per_100: null };
  let samples = perHandNet.map(net => net / bigBlind);
  if (duplicate) {
    const pairs = [];
    for (let index = 0; index + 1 < samples.length; index += 2) pairs.push((samples[index] + samples[index + 1]) / 2);
    samples = pairs;
  }
  const count = samples.length;
  if (!count) return { hands, bb_per_100: null, standard_error_bb_per_100: null };
  const mean = samples.reduce((total, value) => total + value, 0) / count;
  const variance = count > 1 ? samples.reduce((total, value) => total + (value - mean) ** 2, 0) / (count - 1) : 0;
  return {
    hands,
    bb_per_100: Number((mean * 100).toFixed(1)),
    standard_error_bb_per_100: count > 1 ? Number((Math.sqrt(variance / count) * 100).toFixed(1)) : null
  };
}

function countSources(log, seat) {
  const counts = { decisions: 0, jev: 0, fallback: 0, forced: 0, by_reason: {}, agrees_with_rule: 0 };
  for (const hand of log) {
    for (const action of hand.actions) {
      if (action.seat !== seat) continue;
      counts.decisions += 1;
      const source = action.meta?.source;
      if (source === 'jev') {
        counts.jev += 1;
        if (action.meta.agrees_with_rule) counts.agrees_with_rule += 1;
      } else if (source === 'fallback') {
        counts.fallback += 1;
        counts.by_reason[action.meta.reason] = (counts.by_reason[action.meta.reason] || 0) + 1;
      } else if (source === 'forced') {
        counts.forced += 1;
      }
    }
  }
  return counts;
}

/**
 * Play hands between two to six players. Each player exposes `decide(view, context)` and returns
 * `{ label, meta }`. The button starts at seat 0 and moves to the next seat with chips each hand.
 * A player with no chips sits out; the match ends when fewer than two players have chips.
 */
export async function playMatch({
  players,
  hands = 10,
  stack = 200,
  smallBlind = 1,
  bigBlind = 2,
  resetStacks = false,
  duplicate = false,
  decisionTimeoutMs = 0,
  now = () => performance.now(),
  random = Math.random,
  onEvent = () => {}
}) {
  if (!Array.isArray(players) || players.length < MIN_SEATS || players.length > MAX_SEATS || players.some(player => typeof player?.decide !== 'function')) {
    throw new TypeError(`playMatch needs ${MIN_SEATS} to ${MAX_SEATS} players with decide(view, context)`);
  }
  if (!Number.isSafeInteger(hands) || hands < 1 || hands > MATCH_LIMITS.maxHands) throw new RangeError(`hands must be 1 to ${MATCH_LIMITS.maxHands}`);
  if (!Number.isSafeInteger(stack) || stack < MATCH_LIMITS.minStack || stack > MATCH_LIMITS.maxStack) {
    throw new RangeError(`stack must be ${MATCH_LIMITS.minStack} to ${MATCH_LIMITS.maxStack}`);
  }
  if (!Number.isSafeInteger(bigBlind) || stack < bigBlind * 2) throw new RangeError('stack must be at least two big blinds');
  if (!Number.isSafeInteger(decisionTimeoutMs) || decisionTimeoutMs < 0 || decisionTimeoutMs > MATCH_LIMITS.maxDecisionTimeoutMs) {
    throw new RangeError(`decisionTimeoutMs must be 0 (no limit) to ${MATCH_LIMITS.maxDecisionTimeoutMs}`);
  }
  const seats = players.map((_, seat) => seat);
  if (duplicate && (players.length !== 2 || !resetStacks || hands % 2 !== 0)) throw new RangeError('duplicate deals need two players, resetStacks and an even number of hands');
  let stacks = seats.map(() => stack);
  let pairedDeck = null;
  let button = -1;
  const profiles = seats.map(() => emptyProfile());
  const log = [];
  const perHandNet = seats.map(() => []);
  let illegalActions = 0;
  let stopReason = 'hands_complete';

  for (let handNumber = 1; handNumber <= hands; handNumber += 1) {
    if (resetStacks) stacks = seats.map(() => stack);
    if (stacks.filter(chips => chips > 0).length < 2) {
      stopReason = 'player_out_of_chips';
      break;
    }
    // The button passes to the next seat that still has chips.
    do button = (button + 1) % players.length; while (stacks[button] === 0);
    // Duplicate deals: every deck is played twice with the button, and so the cards, swapped.
    if (duplicate && handNumber % 2 === 1) pairedDeck = shuffle(newDeck(), random);
    const hand = startHand({ stacks, button, smallBlind, bigBlind, random, handNumber, deck: duplicate ? pairedDeck : undefined });
    const record = { hand_number: handNumber, button, starting_stacks: [...stacks], hole_cards: hand.holeCards.map(cards => (cards ? [...cards] : null)), actions: [] };
    await onEvent({ type: 'hand_start', hand_number: handNumber, button, stacks: [...stacks], views: seats.map(seat => seatView(hand, seat)) });

    let quit = false;
    while (hand.status === 'playing') {
      const seat = hand.toAct;
      const view = seatView(hand, seat);
      const streetBefore = hand.street;
      const facingRaise = view.to_call > 0 && hand.actions.some(action => action.seat !== seat && action.street === hand.street && isRaise(action.label));
      const opponentProfiles = Object.fromEntries(seats.filter(other => other !== seat).map(other => [other, { ...profiles[other] }]));
      let decision;
      let thinkMs;
      try {
        // `opponentProfile` is the single opponent at a two-player table; `opponentProfiles` has every seat.
        const context = { opponentProfile: players.length === 2 ? opponentProfiles[1 - seat] : undefined, opponentProfiles };
        await onEvent({ type: 'turn', hand_number: handNumber, seat, view, deadline_ms: decisionTimeoutMs || null });
        ({ decision, think_ms: thinkMs } = await timedDecision(players[seat], view, context, decisionTimeoutMs, now));
      } catch (error) {
        if (error.code !== 'PLAYER_QUIT') throw error;
        quit = true;
        break;
      }
      let label = decision?.label;
      if (!view.legal_actions.some(action => action.label === label)) {
        illegalActions += 1;
        label = view.legal_actions.some(action => action.label === 'check') ? 'check' : 'fold';
      }
      applyAction(hand, label);
      const applied = hand.actions.at(-1);
      record.actions.push({ ...applied, think_ms: thinkMs, meta: decision?.meta ?? null });
      const profile = profiles[seat];
      profile.decisions += 1;
      if (isRaise(label)) profile.raises += 1;
      if (facingRaise) {
        profile.faced_raises += 1;
        if (label === 'fold') profile.folds_to_raise += 1;
      }
      const pot = hand.contributed.reduce((total, chips) => total + chips, 0);
      // Chips and bets after the action, including any unmatched bet the engine has just returned.
      // When the action ends the hand the pot has already been paid out; report the chips before that payout.
      const chipsBehind = hand.status === 'complete' ? hand.stacks.map((chips, other) => chips - hand.result.payouts[other]) : [...hand.stacks];
      await onEvent({ type: 'action', hand_number: handNumber, seat, action: { ...applied }, think_ms: thinkMs, meta: decision?.meta ?? null, pot, stacks: chipsBehind, committed: [...hand.committed], in_hand: [...hand.inHand] });
      if (hand.status === 'playing' && hand.street !== streetBefore) {
        await onEvent({ type: 'street', hand_number: handNumber, street: hand.street, board: [...hand.board], pot });
      }
    }
    if (quit) {
      // An abandoned hand is not counted; stacks stay as they were before it.
      stopReason = 'player_quit';
      break;
    }
    const result = publicResult(hand);
    stacks = [...hand.stacks];
    record.board = [...hand.board];
    record.result = { reason: result.reason, winner: result.winner, winners: result.winners, pot: result.pot, pots: result.pots, net: result.net, hand_names: result.hand_names };
    log.push(record);
    for (const seat of seats) perHandNet[seat].push(result.net[seat]);
    await onEvent({ type: 'hand_end', hand_number: handNumber, result, views: seats.map(seat => seatView(hand, seat)) });
  }

  return {
    stop_reason: stopReason,
    hands_played: log.length,
    seats: players.length,
    blinds: { small: smallBlind, big: bigBlind },
    starting_stack: stack,
    reset_stacks: resetStacks,
    duplicate_deals: duplicate,
    decision_timeout_ms: decisionTimeoutMs,
    final_stacks: stacks,
    illegal_actions: illegalActions,
    players: players.map((player, seat) => ({
      seat,
      name: player.name,
      kind: player.kind,
      net_chips: perHandNet[seat].reduce((total, value) => total + value, 0),
      ...summarize(perHandNet[seat], bigBlind, duplicate),
      decision_sources: countSources(log, seat),
      ...thinkStats(log, seat),
      observed_profile: profiles[seat]
    })),
    log
  };
}
