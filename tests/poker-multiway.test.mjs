import assert from 'node:assert/strict';
import test from 'node:test';
import { newDeck, seededRandom } from '../src/cards.mjs';
import { describeSituation } from '../src/describe.mjs';
import { applyAction, legalActions, publicResult, seatView, startHand } from '../src/engine.mjs';
import { estimateEquity } from '../src/equity.mjs';
import { playMatch } from '../src/match.mjs';
import { buildAgentPrompt, createRulePlayer } from '../src/players.mjs';

// A deck whose dealing order is known: cards are dealt button first, then clockwise, then the board.
function deckDealing(hands, board) {
  const wanted = [...hands.flat(), ...board];
  const rest = newDeck().filter(card => !wanted.includes(card));
  return [...rest, ...wanted.reverse()];
}

const labels = hand => legalActions(hand).map(action => action.label);
const BOARD = ['2c', '7d', '9h', 'Js', '3c'];

test('blinds and action order follow the button at three and six seats', () => {
  const three = startHand({ stacks: [200, 200, 200], button: 0, random: seededRandom(1) });
  assert.deepEqual([three.smallBlindSeat, three.bigBlindSeat, three.toAct], [1, 2, 0]);
  assert.deepEqual(three.committed, [0, 1, 2]);
  applyAction(three, 'call');
  assert.equal(three.toAct, 1);
  applyAction(three, 'call');
  assert.equal(three.toAct, 2, 'the big blind has the option');
  assert.deepEqual(labels(three), ['check', 'raise_small', 'raise_large', 'all_in']);
  applyAction(three, 'check');
  assert.deepEqual([three.street, three.toAct], ['flop', 1], 'the seat left of the button acts first after the flop');

  const six = startHand({ stacks: Array(6).fill(200), button: 2, random: seededRandom(2) });
  assert.deepEqual([six.smallBlindSeat, six.bigBlindSeat, six.toAct], [3, 4, 5]);
  for (const expected of [5, 0, 1, 2, 3]) {
    assert.equal(six.toAct, expected);
    applyAction(six, 'call');
  }
  assert.equal(six.toAct, 4);
  applyAction(six, 'check');
  assert.deepEqual([six.street, six.toAct], ['flop', 3]);
  assert.equal(seatView(six, 2).position, 'button');
  assert.equal(seatView(six, 0).opponents.length, 5);
});

test('a raise reopens the betting and the round closes when everyone has matched it', () => {
  const hand = startHand({ stacks: [200, 200, 200], button: 0, random: seededRandom(3) });
  applyAction(hand, 'call');
  applyAction(hand, 'raise_small');
  assert.equal(hand.toAct, 2);
  applyAction(hand, 'call');
  assert.equal(hand.toAct, 0, 'the caller before the raise must act again');
  assert.equal(hand.street, 'preflop');
  applyAction(hand, 'call');
  assert.equal(hand.street, 'flop');
  assert.equal(hand.committed.every(chips => chips === 0), true);
});

test('side pots pay each contribution level to the best hand that reached it', () => {
  // Seat 0 (10 chips) holds aces, seat 1 (50) kings, seat 2 (200) queens.
  const deck = deckDealing([['As', 'Ad'], ['Ks', 'Kd'], ['Qs', 'Qd']], BOARD);
  const hand = startHand({ stacks: [10, 50, 200], button: 0, deck });
  assert.deepEqual(hand.holeCards, [['As', 'Ad'], ['Ks', 'Kd'], ['Qs', 'Qd']]);
  applyAction(hand, 'all_in');
  applyAction(hand, 'all_in');
  assert.equal(hand.committed[1], 50);
  assert.deepEqual(labels(hand), ['fold', 'call'], 'nobody is left to raise against');
  applyAction(hand, 'call');
  const result = publicResult(hand);
  assert.equal(result.reason, 'showdown');
  assert.deepEqual(result.pots, [
    { amount: 30, eligible: [0, 1, 2], winners: [0] },
    { amount: 80, eligible: [1, 2], winners: [1] }
  ]);
  assert.deepEqual(result.net, [20, 30, -50]);
  assert.deepEqual(result.stacks, [30, 80, 150], 'the big stack was never asked for more than the second stack could match');
  assert.deepEqual(result.winners, [0, 1]);
  assert.equal(result.winner, null);
  assert.equal(result.stacks.reduce((a, b) => a + b, 0), 260);

  // Same stacks, but the big stack holds the best hand and takes every pot.
  const reversed = startHand({ stacks: [10, 50, 200], button: 0, deck: deckDealing([['Qs', 'Qd'], ['Ks', 'Kd'], ['As', 'Ad']], BOARD) });
  for (const label of ['all_in', 'all_in', 'call']) applyAction(reversed, label);
  assert.deepEqual(publicResult(reversed).stacks, [0, 0, 260]);
  assert.equal(publicResult(reversed).winner, 2);
});

test('a folded player never wins, their chips stay in the pot, and their cards stay hidden', () => {
  const deck = deckDealing([['As', 'Ad'], ['Ks', 'Kd'], ['Qs', 'Qd']], BOARD);
  const hand = startHand({ stacks: [200, 200, 200], button: 0, deck });
  applyAction(hand, 'raise_large');
  applyAction(hand, 'call');
  applyAction(hand, 'call');
  // Flop: seat 1 bets, seat 2 calls, seat 0 (aces) folds.
  applyAction(hand, 'raise_small');
  applyAction(hand, 'call');
  applyAction(hand, 'fold');
  while (hand.status === 'playing') applyAction(hand, 'check');
  const result = publicResult(hand);
  assert.equal(result.winner, 1, 'kings beat queens once the aces are gone');
  assert.equal(result.shown_cards[0], null);
  assert.deepEqual(result.shown_cards[1], ['Ks', 'Kd']);
  assert.equal(result.hand_names[0], null);
  assert.equal(result.net.reduce((a, b) => a + b, 0), 0);
  assert.ok(result.net[0] < 0 && result.net[1] > 0);
  assert.ok(!JSON.stringify(seatView(hand, 1)).includes('As'));

  const walk = startHand({ stacks: [200, 200, 200], button: 0, random: seededRandom(4) });
  applyAction(walk, 'fold');
  applyAction(walk, 'fold');
  assert.deepEqual([publicResult(walk).reason, publicResult(walk).winner, publicResult(walk).net], ['fold', 2, [0, -1, 1]]);
  assert.equal(publicResult(walk).shown_cards, null);
});

test('a tied pot splits and the odd chip goes to the first winner left of the button', () => {
  // Seats 1 and 2 both play the board's straight; seat 0 folds after calling.
  const deck = deckDealing([['2h', '3h'], ['Ah', 'Kd'], ['Ad', 'Kc']], ['Ts', 'Jd', 'Qh', '4c', '5s']);
  const hand = startHand({ stacks: [200, 200, 200], button: 0, deck });
  applyAction(hand, 'call');
  applyAction(hand, 'call');
  applyAction(hand, 'check');
  applyAction(hand, 'raise_small');
  applyAction(hand, 'call');
  applyAction(hand, 'fold');
  while (hand.status === 'playing') applyAction(hand, 'check');
  const result = publicResult(hand);
  assert.deepEqual(result.winners, [1, 2]);
  assert.equal(result.pot % 2, 0);
  assert.deepEqual([result.net[1], result.net[2]], [1, 1], 'each winner takes half of the folder\'s two chips');

  const odd = startHand({ stacks: [200, 200, 200], button: 0, deck, smallBlind: 1, bigBlind: 3 });
  applyAction(odd, 'call');
  applyAction(odd, 'call');
  // Everyone checks to the showdown; seat 0's low cards lose to the shared straight.
  while (odd.status === 'playing') applyAction(odd, 'check');
  const split = publicResult(odd);
  assert.equal(split.pot, 9);
  assert.deepEqual(split.payouts, [0, 5, 4], 'seat 1 sits left of the button and takes the odd chip');
});

test('a seat with no chips is not dealt in and the button passes over it', async () => {
  const hand = startHand({ stacks: [100, 0, 100, 100], button: 0, random: seededRandom(5) });
  assert.equal(hand.holeCards[1], null);
  assert.deepEqual([hand.smallBlindSeat, hand.bigBlindSeat, hand.toAct], [2, 3, 0]);
  assert.deepEqual(seatView(hand, 1).hole_cards, []);
  assert.deepEqual(seatView(hand, 0).opponents.map(opponent => opponent.seat), [2, 3]);
  assert.equal(seatView(hand, 0).players_dealt_in, 3);
  assert.throws(() => startHand({ stacks: [100, 0, 0], button: 0 }), /at least two players/);
  assert.throws(() => startHand({ stacks: [100, 0, 100], button: 1 }), /seat with chips/);
  assert.throws(() => startHand({ stacks: Array(7).fill(100), button: 0 }), /2 to 6/);

  const random = seededRandom(6);
  const allIn = { name: 'Shove', kind: 'scripted', decide: async view => ({ label: view.legal_actions.some(action => action.label === 'all_in') ? 'all_in' : 'call', meta: null }) };
  // Three players shove every hand; the fourth only folds or checks, so the match outlives the first bust.
  const quiet = { name: 'Quiet', kind: 'scripted', decide: async view => ({ label: view.legal_actions.some(action => action.label === 'check') ? 'check' : 'fold', meta: null }) };
  const match = await playMatch({ players: [allIn, allIn, allIn, quiet], hands: 12, stack: 20, random });
  assert.equal(match.final_stacks.reduce((a, b) => a + b, 0), 80);
  const busted = match.log.find(record => record.starting_stacks.includes(0));
  assert.ok(busted, 'someone runs out of chips');
  for (const record of match.log) {
    assert.ok(record.starting_stacks[record.button] > 0, 'the button is always a player with chips');
    record.starting_stacks.forEach((chips, seat) => assert.equal(record.hole_cards[seat] === null, chips === 0));
  }
  assert.equal(match.illegal_actions, 0);
});

test('odds fall as opponents are added and the two-player scale stays comparable', () => {
  const random = seededRandom(7);
  const one = estimateEquity(['As', 'Ad'], [], { iterations: 1500, random, opponents: 1 });
  const five = estimateEquity(['As', 'Ad'], [], { iterations: 1500, random, opponents: 5 });
  assert.ok(one > 0.8 && five < 0.6 && five > 0.4, `aces: ${one} against one, ${five} against five`);
  assert.throws(() => estimateEquity(['As', 'Ad'], [], { opponents: 6 }), /one to five/);

  const hand = startHand({ stacks: Array(6).fill(200), button: 0, deck: deckDealing([['7c', '2d'], ['8c', '3d'], ['9c', '4d'], ['As', 'Ad'], ['Tc', '5d'], ['Jc', '6d']], ['2s', '7h', '9d', 'Kh', '3s']) });
  const view = seatView(hand, 3);
  const { facts, state } = describeSituation(view, { random: seededRandom(8), iterations: 600 });
  assert.equal(facts.opponents_in, 5);
  assert.ok(facts.win_chance < facts.raw_equity, 'strength is rescaled to the two-player scale');
  assert.equal(state.my_hand_strength, 'very strong');
  assert.equal(state.opponents_still_in, 'five');
  assert.equal(state.raises_this_round, 'none');
  assert.match(state.game, /several players/);
  assert.doesNotMatch(JSON.stringify(state), /\d/, 'the state sent to Jev stays in words');
  const prompt = buildAgentPrompt(view, { facts, state });
  assert.match(prompt, /table of 6 players/);
  for (const card of ['7c', '8c', '9c', 'Tc', 'Jc']) assert.ok(!prompt.includes(card), `prompt must not contain ${card}`);
});

test('seeded matches of two to six rule bots conserve chips and stay legal', async () => {
  for (const count of [2, 3, 4, 5, 6]) {
    const random = seededRandom(100 + count);
    const players = Array.from({ length: count }, (_, seat) => createRulePlayer({ name: `Bot ${seat}`, random, iterations: 40 }));
    const match = await playMatch({ players, hands: 40, stack: 60, random });
    assert.equal(match.illegal_actions, 0);
    assert.equal(match.seats, count);
    for (const record of match.log) {
      assert.equal(record.result.net.reduce((a, b) => a + b, 0), 0, `${count} seats, hand ${record.hand_number} conserves chips`);
      assert.equal(record.result.pots.reduce((total, pot) => total + pot.amount, 0), record.result.pot);
      assert.ok(record.result.pots.every(pot => pot.winners.every(seat => pot.eligible.includes(seat))));
    }
    assert.equal(match.final_stacks.reduce((a, b) => a + b, 0), count * 60);
    assert.equal(match.players.reduce((total, player) => total + player.net_chips, 0), 0);
  }
  await assert.rejects(() => playMatch({ players: Array(7).fill(createRulePlayer()), hands: 2 }), /2 to 6 players/);
  await assert.rejects(() => playMatch({ players: Array(3).fill(createRulePlayer()), hands: 2, resetStacks: true, duplicate: true }), /two players/);
});

test('a short all-in raise reopens the betting for the players who already acted', () => {
  // Seat 2 posts the big blind from a stack of 7, so its all-in is a raise of 2 on a bet of 5,
  // less than the full raise of 3. The design spec lets any raise reopen the betting.
  const hand = startHand({ stacks: [200, 200, 7], button: 0, random: seededRandom(9) });
  applyAction(hand, 'raise_small');
  assert.deepEqual([hand.currentBet, hand.lastRaiseSize], [5, 3]);
  applyAction(hand, 'call');
  assert.equal(hand.toAct, 2);
  assert.deepEqual(legalActions(hand).map(action => [action.label, action.to]), [['fold', 2], ['call', 5], ['all_in', 7]], 'the short stack can only fold, call or go all-in');
  applyAction(hand, 'all_in');
  assert.ok(hand.currentBet - 5 < hand.lastRaiseSize, 'the all-in is less than a full raise');
  assert.deepEqual([hand.status, hand.street, hand.currentBet, hand.toAct], ['playing', 'preflop', 7, 0], 'the raiser must act again');
  assert.deepEqual(legalActions(hand).map(action => action.label), ['fold', 'call', 'raise_small', 'raise_large', 'all_in'], 'and may raise again');
  assert.deepEqual(legalActions(hand).find(action => action.label === 'call'), { label: 'call', amount: 2, to: 7 });
  applyAction(hand, 'call');
  assert.deepEqual([hand.street, hand.toAct], ['preflop', 1], 'the caller must act again too');
  assert.deepEqual(labels(hand), ['fold', 'call', 'raise_small', 'raise_large', 'all_in']);
  applyAction(hand, 'call');
  assert.deepEqual([hand.street, hand.toAct], ['flop', 1], 'the round closes once both have matched the all-in');
  assert.deepEqual(hand.contributed, [7, 7, 7]);
  assert.equal(seatView(hand, 0).opponents.find(opponent => opponent.seat === 2).all_in, true);
  while (hand.status === 'playing') applyAction(hand, 'check');
  const result = publicResult(hand);
  assert.deepEqual(result.pots.map(pot => [pot.amount, pot.eligible]), [[21, [0, 1, 2]]]);
  assert.equal(result.stacks.reduce((a, b) => a + b, 0), 407);
});

test('an unmatched bet comes back when the only caller is all-in for less', () => {
  // Seat 0 holds kings, seat 1 (six chips) aces, seat 2 queens. Everyone sees the flop for two chips.
  const deal = hands => startHand({ stacks: [200, 6, 200], button: 0, deck: deckDealing(hands, BOARD) });
  const play = hand => {
    for (const label of ['call', 'call', 'check']) applyAction(hand, label);
    assert.deepEqual([hand.street, hand.toAct, hand.stacks], ['flop', 1, [198, 4, 198]]);
    // Seat 1 and seat 2 check, seat 0 bets six, seat 1 calls with its last four chips, seat 2 folds.
    applyAction(hand, 'check');
    applyAction(hand, 'check');
    applyAction(hand, 'raise_large');
    assert.deepEqual(hand.committed, [6, 0, 0]);
    assert.deepEqual(legalActions(hand).map(action => [action.label, action.amount]), [['fold', 0], ['call', 4]], 'a call for less is the short stack\'s only way to stay in');
    applyAction(hand, 'call');
    assert.equal(hand.status, 'playing', 'seat 2 still has to answer the bet');
    applyAction(hand, 'fold');
    return publicResult(hand);
  };

  const shortWins = play(deal([['Ks', 'Kd'], ['As', 'Ad'], ['Qs', 'Qd']]));
  assert.equal(shortWins.reason, 'showdown', 'nobody is left to bet, so the board runs out');
  assert.equal(shortWins.board.length, 5);
  assert.deepEqual(shortWins.pots, [{ amount: 14, eligible: [0, 1], winners: [1] }], 'two unmatched chips left the pot before it was awarded');
  assert.deepEqual([shortWins.pot, shortWins.winner, shortWins.winners], [14, 1, [1]]);
  assert.deepEqual(shortWins.stacks, [194, 14, 198]);
  assert.deepEqual(shortWins.net, [-6, 8, -2], 'seat 0 loses only what seat 1 could match');
  assert.deepEqual(shortWins.shown_cards, [['Ks', 'Kd'], ['As', 'Ad'], null]);
  assert.equal(shortWins.stacks.reduce((a, b) => a + b, 0), 406);

  const bettorWins = play(deal([['As', 'Ad'], ['Ks', 'Kd'], ['Qs', 'Qd']]));
  assert.deepEqual(bettorWins.pots, [{ amount: 14, eligible: [0, 1], winners: [0] }]);
  assert.deepEqual(bettorWins.stacks, [208, 0, 198]);
  assert.deepEqual(bettorWins.net, [8, -6, -2]);
});

test('a folded player\'s chips above a short all-in go to the bettor who matched them', () => {
  // Seat 0 holds kings, seat 1 queens, seat 2 (six chips) aces. Seat 0 raises to 5, seat 1 to 11,
  // seat 2 calls all-in for 6, seat 0 raises to 25 and seat 1 folds with 11 chips in.
  const hand = startHand({ stacks: [200, 200, 6], button: 0, deck: deckDealing([['Ks', 'Kd'], ['Qs', 'Qd'], ['As', 'Ad']], BOARD) });
  for (const label of ['raise_small', 'raise_small', 'call', 'raise_small']) applyAction(hand, label);
  assert.deepEqual([hand.committed, hand.toAct], [[25, 11, 6], 1]);
  applyAction(hand, 'fold');
  const result = publicResult(hand);
  assert.equal(result.reason, 'showdown');
  // Only 14 of the last raise were unmatched: seat 1 had matched 11 before folding. The aces win
  // the six chips each player put in; the five more that seats 0 and 1 both put in were never
  // seat 2's to win, so they go to seat 0.
  assert.deepEqual(result.pots, [
    { amount: 18, eligible: [0, 2], winners: [2] },
    { amount: 10, eligible: [0], winners: [0] }
  ]);
  assert.deepEqual([result.winner, result.winners], [2, [2]], 'taking back an uncontested side pot is not a win');
  assert.deepEqual(result.stacks, [199, 189, 18]);
  assert.deepEqual(result.net, [-1, -11, 12]);
  assert.deepEqual(result.shown_cards, [['Ks', 'Kd'], null, ['As', 'Ad']]);
  assert.equal(result.stacks.reduce((a, b) => a + b, 0), 406);
});

test('playMatch times every decision, cuts off a slow player, and shows each seat the others\' habits', async () => {
  // An injected clock that moves five milliseconds each time it is read: a decision reads it twice.
  let clock = 0;
  const now = () => (clock += 5);
  const contexts = [];
  const quick = seat => ({
    name: `Quick ${seat}`,
    kind: 'scripted',
    decide: async (view, context) => {
      contexts.push({ seat, context });
      return { label: view.legal_actions.some(action => action.label === 'check') ? 'check' : 'call', meta: null };
    }
  });
  const events = [];
  const timed = await playMatch({ players: [quick(0), quick(1), quick(2)], hands: 3, random: seededRandom(31), now, onEvent: event => events.push(event) });
  assert.equal(timed.decision_timeout_ms, 0);
  const actions = timed.log.flatMap(record => record.actions);
  assert.ok(actions.length >= 9 && actions.every(action => action.think_ms === 5), 'each action carries the time its decision took');
  for (const player of timed.players) {
    const mine = actions.filter(action => action.seat === player.seat);
    assert.deepEqual([player.think_ms_total, player.think_ms_mean, player.think_ms_max], [mine.length * 5, 5, 5]);
  }
  // Every decision is announced first, with the view the player is about to receive.
  const turns = events.filter(event => event.type === 'turn');
  const played = events.filter(event => event.type === 'action');
  assert.equal(turns.length, actions.length);
  assert.deepEqual(turns.map(event => event.seat), played.map(event => event.seat));
  assert.ok(turns.every(event => event.deadline_ms === null && event.view.seat === event.seat && event.view.legal_actions.length > 0));
  assert.ok(played.every(event => event.think_ms === 5));
  events.forEach((event, index) => {
    if (event.type === 'action') assert.equal(events[index - 1].type, 'turn', 'a turn event comes right before its action');
  });
  for (const { seat, context } of contexts) {
    assert.ok(context.signal instanceof AbortSignal && !context.signal.aborted, 'an answer in time is never cut off');
    assert.deepEqual(Object.keys(context.opponentProfiles).map(Number), [0, 1, 2].filter(other => other !== seat));
    assert.equal(context.opponentProfile, undefined, 'the single-opponent profile is for two players only');
    assert.equal(context.deadline_ms, null);
  }
  assert.equal(contexts.at(-1).context.opponentProfiles[contexts.at(-1).seat === 0 ? 1 : 0].decisions > 0, true);

  // A player that never answers is checked or folded when the limit runs out, and told to stop.
  const signals = [];
  const stuck = { name: 'Stuck', kind: 'model', decide: (view, context) => new Promise(() => signals.push(context.signal)) };
  const slow = await playMatch({ players: [stuck, quick(1)], hands: 2, decisionTimeoutMs: 15, random: seededRandom(32) });
  const stuckActions = slow.log.flatMap(record => record.actions.filter(action => action.seat === 0));
  assert.ok(stuckActions.length >= 2);
  for (const action of stuckActions) {
    assert.ok(['check', 'fold'].includes(action.label));
    assert.deepEqual([action.think_ms, action.meta], [15, { source: 'fallback', reason: 'timeout' }]);
  }
  assert.deepEqual([signals.length, signals.every(signal => signal.aborted)], [stuckActions.length, true]);
  assert.deepEqual([slow.illegal_actions, slow.decision_timeout_ms], [0, 15]);
  assert.deepEqual(slow.players[0].decision_sources.by_reason, { timeout: stuckActions.length });
  assert.deepEqual([slow.players[0].think_ms_mean, slow.players[0].think_ms_max, slow.players[0].think_ms_total], [15, 15, 15 * stuckActions.length]);
  assert.equal(contexts.at(-1).context.deadline_ms, 15);
  assert.equal(typeof contexts.at(-1).context.opponentProfile.decisions, 'number', 'two players still get the single profile');

  // An answer inside the limit is timed like any other.
  const inTime = await playMatch({ players: [quick(0), quick(1), quick(2)], hands: 2, decisionTimeoutMs: 5000, now, random: seededRandom(33) });
  const inTimeActions = inTime.log.flatMap(record => record.actions);
  assert.ok(inTimeActions.length >= 6 && inTimeActions.every(action => action.think_ms === 5 && action.meta === null));
  assert.deepEqual(inTime.players.map(player => [player.think_ms_mean, player.think_ms_max, player.decision_sources.fallback]), Array(3).fill([5, 5, 0]));
  await assert.rejects(() => playMatch({ players: [quick(0), quick(1)], decisionTimeoutMs: -1 }), /decisionTimeoutMs/);
  await assert.rejects(() => playMatch({ players: [quick(0), quick(1)], decisionTimeoutMs: 600_001 }), /decisionTimeoutMs/);
  await assert.rejects(() => playMatch({ players: [quick(0), quick(1)], stack: 1_000_001 }), /stack must be 20 to 1000000/);
  assert.equal((await playMatch({ players: [quick(0), quick(1)], hands: 1, stack: 1_000_000, random: seededRandom(34) })).starting_stack, 1_000_000);
});
