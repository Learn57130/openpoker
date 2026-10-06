import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { newDeck, seededRandom } from '../src/cards.mjs';
import { describeSituation } from '../src/describe.mjs';
import { applyAction, legalActions, seatView, startHand } from '../src/engine.mjs';
import { compareHands, evaluateHand } from '../src/evaluate.mjs';
import { playMatch } from '../src/match.mjs';
import { buildAgentPrompt, createJevPlayer, createRulePlayer, createScriptedPlayer, ruleAction } from '../src/players.mjs';
import { buildPokerDecisionQuestion, normalizePokerDecisionInput, POKER_ACTION_LABELS, runPokerDecision } from '../src/poker-decision.mjs';

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, '..');

function choice(selected, keys, confidence = 0.9) {
  return {
    type: 'choice',
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 0.9 : 0.1 / (keys.length - 1)]))
  };
}

// A deck whose dealing order is known: `startHand` pops from the end, button first.
function deckDealing({ button, other, board }) {
  const wanted = [...button, ...other, ...board];
  const rest = newDeck().filter(card => !wanted.includes(card));
  return [...rest, ...wanted.reverse()];
}

function mockClient(answer) {
  const calls = [];
  return {
    calls,
    async ask(state, questions) {
      calls.push({ state, questions });
      const keys = Object.keys(questions.action.criteria);
      const action = typeof answer === 'function' ? answer({ state, keys }) : answer;
      return { body: { model: 'jev-test', answers: { action }, usage: { input_tokens: 600, output_tokens: 40 } }, latency_ms: 5 };
    }
  };
}

test('hand evaluator ranks categories, kickers, and the low-ace straight', () => {
  assert.equal(evaluateHand(['As', '2d', '3h', '4c', '5s', 'Kd', 'Qh']).name, 'straight');
  assert.deepEqual(evaluateHand(['As', '2d', '3h', '4c', '5s', 'Kd', 'Qh']).tiebreak.slice(0, 1), [5]);
  assert.ok(compareHands(['6s', '2d', '3h', '4c', '5s', 'Kd', 'Qh'], ['As', '2d', '3h', '4c', '5s', 'Kd', 'Qh']) > 0, 'six-high straight beats the wheel');
  assert.ok(compareHands(['2h', '7h', '9h', 'Jh', 'Kh', '3s', '4d'], ['5s', '6d', '7h', '8c', '9s', '2d', 'Kc']) > 0, 'flush beats straight');
  assert.ok(compareHands(['Ks', 'Kd', 'Kh', '2c', '2s', '9d', '4h'], ['2h', '7h', '9h', 'Jh', 'Ah', '3s', '4d']) > 0, 'full house beats flush');
  assert.ok(compareHands(['As', 'Ad', 'Kh', '7c', '5s', '3d', '2h'], ['Ah', 'Ac', 'Qh', '7d', '5c', '3s', '2d']) > 0, 'kicker decides equal pairs');
  assert.equal(compareHands(['As', 'Kd', '9h', '8c', '7s', '6d', '5h'], ['Ac', 'Kh', '9d', '8s', '7h', '6c', '5d']), 0, 'same straight ties');
  const threePairs = evaluateHand(['As', 'Ad', 'Kh', 'Kc', 'Qs', 'Qd', '2h']);
  assert.equal(threePairs.name, 'two pair');
  assert.deepEqual(threePairs.tiebreak.slice(0, 3), [14, 13, 12]);
  // The overall straight is nine-high, but the straight flush in hearts is only eight-high.
  const straightFlush = evaluateHand(['4h', '5h', '6h', '7h', '8h', '9s', 'Td']);
  assert.equal(straightFlush.name, 'straight flush');
  assert.equal(straightFlush.tiebreak[0], 8);
  assert.throws(() => evaluateHand(['As', 'As', 'Kd', 'Qd', 'Jd']), /duplicate/);
});

test('engine enforces blinds, legal actions, raise sizing, and all-in refunds', () => {
  const hand = startHand({ stacks: [200, 200], button: 0, random: seededRandom(1) });
  assert.equal(hand.toAct, 0);
  assert.deepEqual(hand.committed, [1, 2]);
  assert.deepEqual(legalActions(hand).map(action => [action.label, action.to]), [['fold', 1], ['call', 2], ['raise_small', 4], ['raise_large', 6], ['all_in', 200]]);
  assert.throws(() => applyAction(hand, 'check'), error => error.code === 'ILLEGAL_ACTION');
  applyAction(hand, 'call');
  assert.equal(hand.street, 'preflop', 'the big blind still has the option');
  assert.deepEqual(legalActions(hand).map(action => action.label), ['check', 'raise_small', 'raise_large', 'all_in']);
  applyAction(hand, 'check');
  assert.equal(hand.street, 'flop');
  assert.equal(hand.board.length, 3);
  assert.equal(hand.toAct, 1, 'the big blind acts first after the flop');

  const capped = startHand({ stacks: [200, 200], button: 0, random: seededRandom(2) });
  for (let raises = 0; raises < 4; raises += 1) applyAction(capped, 'raise_small');
  assert.deepEqual(legalActions(capped).map(action => action.label), ['fold', 'call'], 'raises are capped per round');

  // The short stack is all-in for 10; the deep stack can never be asked for more than that.
  const short = startHand({ stacks: [10, 200], button: 1, random: seededRandom(3) });
  assert.equal(legalActions(short).find(action => action.label === 'all_in').to, 10);
  applyAction(short, 'all_in');
  applyAction(short, 'call');
  assert.equal(short.status, 'complete');
  assert.equal(short.result.pot, 20);
  assert.equal(short.stacks[0] + short.stacks[1], 210);

  const blindAllIn = startHand({ stacks: [1, 50], button: 0, random: seededRandom(4) });
  assert.equal(blindAllIn.status, 'complete', 'a blind-sized stack goes straight to showdown');
  assert.equal(blindAllIn.result.pot, 2, 'the unmatched part of the big blind is returned');
  assert.equal(blindAllIn.stacks[0] + blindAllIn.stacks[1], 51);
});

test('a seat view and the state sent to Jev never contain the other seat\'s cards', () => {
  const deck = deckDealing({ button: ['As', 'Kd'], other: ['7c', '7h'], board: ['2s', '9d', 'Jh', '3c', 'Qs'] });
  const hand = startHand({ stacks: [200, 200], button: 0, deck });
  assert.deepEqual(hand.holeCards, [['As', 'Kd'], ['7c', '7h']]);
  applyAction(hand, 'raise_small');
  const view = seatView(hand, 1);
  const viewJson = JSON.stringify(view);
  assert.ok(!viewJson.includes('As') && !viewJson.includes('Kd'));
  assert.deepEqual(view.hole_cards, ['7c', '7h']);
  assert.equal(seatView(hand, 0).legal_actions.length, 0, 'only the seat to act receives actions');

  const { state, facts } = describeSituation(view, { random: seededRandom(5), iterations: 200 });
  const stateJson = JSON.stringify(state);
  for (const card of newDeck()) assert.ok(!stateJson.includes(card), `state must not contain the card code ${card}`);
  assert.doesNotMatch(stateJson, /\d/, 'state must contain words only, no chip counts or odds');
  assert.equal(state.my_made_hand, 'pocket pair');
  assert.equal(state.opponent_this_round, 'made a small raise');
  assert.equal(facts.opponent_raises, 1);
  assert.ok(facts.equity < facts.raw_equity, 'an opponent raise discounts the estimate');

  // The text prompt for Claude or Codex carries this seat's own cards and never the other seat's.
  const prompt = buildAgentPrompt(view, describeSituation(view, { random: seededRandom(5), iterations: 50 }));
  assert.match(prompt, /7c 7h/);
  for (const card of ['As', 'Kd']) assert.ok(!prompt.includes(card), `prompt must not contain ${card}`);
});

test('rule bot follows odds and returns only legal labels', () => {
  const free = [{ label: 'check' }, { label: 'raise_small' }, { label: 'raise_large' }, { label: 'all_in' }];
  const facing = [{ label: 'fold' }, { label: 'call' }, { label: 'raise_small' }, { label: 'all_in' }];
  assert.equal(ruleAction({ equity: 0.4, margin: 0.4, to_call: 0 }, free), 'check');
  assert.equal(ruleAction({ equity: 0.7, margin: 0.7, to_call: 0 }, free), 'raise_small');
  assert.equal(ruleAction({ equity: 0.9, margin: 0.9, to_call: 0 }, free), 'raise_large');
  assert.equal(ruleAction({ equity: 0.3, margin: -0.1, to_call: 10 }, facing), 'fold');
  assert.equal(ruleAction({ equity: 0.45, margin: 0.1, to_call: 10 }, facing), 'call');
  assert.equal(ruleAction({ equity: 0.9, margin: 0.5, to_call: 10 }, facing), 'raise_small', 'falls back to the largest legal raise');
  assert.equal(ruleAction({ equity: 0.9, margin: 0.5, to_call: 10 }, [{ label: 'fold' }, { label: 'call' }]), 'call');
});

test('poker-decision asks only about legal labels and abstains on unclear or low confidence', async () => {
  const situation = { my_hand_strength: 'strong', price_to_call: 'fair', opponent_tendencies: { when_raised: 'folds often' } };
  const legal = ['fold', 'call', 'raise_small'];
  assert.deepEqual(Object.keys(buildPokerDecisionQuestion(legal).action.criteria), ['fold', 'call', 'raise_small', 'unclear']);

  const confident = mockClient(({ keys }) => choice('call', keys));
  const played = await runPokerDecision({ client: confident, input: { situation, legal_actions: legal } });
  assert.equal(played.action, 'call');
  assert.equal(played.abstained, false);
  assert.deepEqual(confident.calls[0].state, situation);
  assert.equal(played.decision.probabilities.call, 0.9, 'raw probabilities are preserved');

  const unsure = await runPokerDecision({ client: mockClient(({ keys }) => choice('raise_small', keys, 0.31)), input: { situation, legal_actions: legal } });
  assert.deepEqual([unsure.action, unsure.abstained, unsure.abstain_reason], [null, true, 'low_confidence']);
  const unclear = await runPokerDecision({ client: mockClient(({ keys }) => choice('unclear', keys)), input: { situation, legal_actions: legal } });
  assert.deepEqual([unclear.action, unclear.abstain_reason], [null, 'unclear']);

  await assert.rejects(
    () => runPokerDecision({ client: mockClient(choice('all_in', ['all_in'])), input: { situation, legal_actions: legal } }),
    error => error.code === 'JEV_INVALID_RESPONSE'
  );
  assert.throws(() => normalizePokerDecisionInput({ situation, legal_actions: ['fold', 'bet_everything'] }), /may contain only/);
  assert.throws(() => normalizePokerDecisionInput({ situation: { pot: 12 }, legal_actions: legal }), /short non-empty string/);
  assert.throws(() => normalizePokerDecisionInput({ situation, legal_actions: [] }), /one to six/);
});

test('poker-decision asks the several-players question when the situation names the opponents still in', async () => {
  const legal = ['fold', 'call', 'raise_small'];
  const twoPlayers = { my_hand_strength: 'strong', price_to_call: 'fair', opponent_tendencies: { when_raised: 'folds often' } };
  const severalPlayers = { ...twoPlayers, opponents_still_in: 'three' };
  const ask = async situation => {
    const client = mockClient(({ keys }) => choice('call', keys));
    const result = await runPokerDecision({ client, input: { situation, legal_actions: legal } });
    assert.equal(client.calls.length, 1);
    return { result, state: client.calls[0].state, question: client.calls[0].questions.action };
  };

  const table = await ask(severalPlayers);
  assert.equal(table.result.question_version, 'poker-decision-questions/v2');
  assert.match(table.question.instructions, /several players/);
  assert.match(table.question.instructions, /`opponents_still_in`/);
  assert.doesNotMatch(table.question.instructions, /two-player/);
  assert.deepEqual(Object.keys(table.question.criteria), ['fold', 'call', 'raise_small', 'unclear'], 'still exactly the legal labels plus unclear');
  assert.deepEqual(table.state, severalPlayers, 'the count of opponents reaches Jev as a word');
  assert.deepEqual([table.result.action, table.result.abstained], ['call', false]);

  const pair = await ask(twoPlayers);
  assert.equal(pair.result.question_version, 'poker-decision-questions/v1');
  assert.match(pair.question.instructions, /two-player/);
  assert.doesNotMatch(pair.question.instructions, /several players|opponents_still_in/);
  assert.deepEqual(Object.keys(pair.question.criteria), ['fold', 'call', 'raise_small', 'unclear']);
  assert.deepEqual([pair.result.action, pair.result.policy_version], ['call', table.result.policy_version], 'one policy for both wordings');

  // The exported builder is what the workflow sends, and both wordings describe all six labels.
  assert.deepEqual(buildPokerDecisionQuestion(legal, { multiway: true }).action, table.question);
  assert.deepEqual(buildPokerDecisionQuestion(legal).action, pair.question);
  assert.deepEqual(buildPokerDecisionQuestion(legal, { multiway: false }).action, pair.question);
  for (const multiway of [false, true]) {
    const { criteria } = buildPokerDecisionQuestion(POKER_ACTION_LABELS, { multiway }).action;
    assert.deepEqual(Object.keys(criteria), [...POKER_ACTION_LABELS, 'unclear']);
    assert.ok(Object.values(criteria).every(text => typeof text === 'string' && text.length > 20), 'every option states its rule');
  }
  assert.notEqual(table.question.criteria.raise_small, pair.question.criteria.raise_small, 'the raise rule differs when several opponents are in');
  assert.equal(table.question.criteria.fold, pair.question.criteria.fold);

  // The wording follows the table: the description of a hand dealt to three names the opponents
  // still in, and the description of a hand dealt to two does not, even at a three-seat table.
  const describe = stacks => describeSituation(seatView(startHand({ stacks, button: 0, random: seededRandom(3) }), 0), { random: seededRandom(5), iterations: 50 }).state;
  assert.equal((await ask(describe([200, 200, 200]))).result.question_version, 'poker-decision-questions/v2');
  assert.equal((await ask(describe([200, 200]))).result.question_version, 'poker-decision-questions/v1');
  assert.equal((await ask(describe([200, 0, 200]))).result.question_version, 'poker-decision-questions/v1', 'two players left with chips are described as two-player poker');
});

test('Jev player plays validated choices and lets the rule bot step in otherwise', async () => {
  const deck = deckDealing({ button: ['As', 'Ad'], other: ['7c', '2h'], board: ['2s', '9d', 'Jh', '3c', 'Qs'] });
  const view = seatView(startHand({ stacks: [200, 200], button: 0, deck }), 0);
  const make = decide => createJevPlayer({ decide, random: seededRandom(6), iterations: 200 });
  const ok = await make(async input => ({ action: 'call', abstained: false, decision: choice('call', [...input.legal_actions, 'unclear']), latency_ms: 4 })).decide(view, {});
  assert.deepEqual([ok.label, ok.meta.source], ['call', 'jev']);
  assert.equal(ok.meta.agrees_with_rule, false, 'the rule bot would raise with aces');
  assert.deepEqual([ok.meta.question_version, ok.meta.model], [null, null], 'a decide function that names neither records neither');
  // Each decision records the question wording and the model that answered it.
  const versioned = { question_version: 'poker-decision-questions/v2', model: 'jev-test' };
  const recorded = await make(async input => ({ ...versioned, action: 'call', abstained: false, decision: choice('call', [...input.legal_actions, 'unclear']) })).decide(view, {});
  assert.deepEqual([recorded.label, recorded.meta.source, recorded.meta.question_version, recorded.meta.model], ['call', 'jev', 'poker-decision-questions/v2', 'jev-test']);

  const abstained = await make(async () => ({ ...versioned, action: null, abstained: true, abstain_reason: 'low_confidence', decision: { choice: 'fold', confidence: 0.2, probabilities: {} } })).decide(view, {});
  assert.deepEqual([abstained.meta.question_version, abstained.meta.model], ['poker-decision-questions/v2', 'jev-test'], 'also when the rule bot steps in');
  const ruleLabel = (await createRulePlayer({ random: seededRandom(6), iterations: 200 }).decide(view)).label;
  assert.match(ruleLabel, /^raise_/);
  assert.deepEqual([abstained.label, abstained.meta.source, abstained.meta.reason], [ruleLabel, 'fallback', 'low_confidence']);

  const invalid = await make(async () => { throw Object.assign(new Error('bad label'), { code: 'JEV_INVALID_RESPONSE' }); }).decide(view, {});
  assert.deepEqual([invalid.label, invalid.meta.reason], [ruleLabel, 'invalid_response']);
  const network = await make(async () => { throw Object.assign(new Error('down'), { code: 'JEV_NETWORK_ERROR' }); }).decide(view, {});
  assert.deepEqual([network.label, network.meta.reason], [ruleLabel, 'error']);
  await assert.rejects(
    () => make(async () => { throw Object.assign(new Error('no key'), { code: 'JEV_HTTP_401' }); }).decide(view, {}),
    error => error.code === 'JEV_HTTP_401'
  );
});

test('matches conserve chips, stay legal, and replay exactly from a seed', async () => {
  const run = async seed => {
    const random = seededRandom(seed);
    return await playMatch({ players: [createRulePlayer({ name: 'A', random, iterations: 60 }), createRulePlayer({ name: 'B', random, iterations: 60 })], hands: 100, resetStacks: true, duplicate: true, random, now: () => 0 });
  };
  const first = await run(11);
  assert.equal(first.hands_played, 100);
  assert.equal(first.illegal_actions, 0);
  for (const hand of first.log) assert.equal(hand.result.net[0] + hand.result.net[1], 0, `hand ${hand.hand_number} conserves chips`);
  assert.equal(first.final_stacks[0] + first.final_stacks[1], 400);
  assert.equal(first.players[0].net_chips + first.players[1].net_chips, 0);
  // Mirrored deals: the second hand of a pair gives each seat the other's cards.
  assert.deepEqual(first.log[0].hole_cards, [first.log[1].hole_cards[1], first.log[1].hole_cards[0]]);
  assert.deepEqual(first.log[0].board.slice(0, 3), first.log[1].board.slice(0, Math.min(3, first.log[0].board.length)));
  assert.deepEqual(await run(11), first, 'same seed, same match');
  assert.notDeepEqual((await run(12)).log[0].hole_cards, first.log[0].hole_cards);

  const random = seededRandom(13);
  const carry = await playMatch({ players: [createScriptedPlayer(Array(40).fill('all_in')), createScriptedPlayer(Array(40).fill('call'))], hands: 40, stack: 20, random });
  assert.equal(carry.stop_reason, 'player_out_of_chips');
  assert.equal(carry.final_stacks[0] + carry.final_stacks[1], 40);
  await assert.rejects(() => playMatch({ players: [createRulePlayer(), createRulePlayer()], hands: 3, resetStacks: true, duplicate: true }), /even number/);
});

test('a player that returns an illegal label is counted and replaced with a safe action', async () => {
  const cheat = { name: 'Cheat', kind: 'scripted', decide: async () => ({ label: 'take_the_pot', meta: null }) };
  const match = await playMatch({ players: [cheat, createScriptedPlayer(Array(10).fill('call'))], hands: 2, random: seededRandom(14) });
  assert.ok(match.illegal_actions >= 2);
  assert.ok(match.log.every(hand => hand.actions.filter(action => action.seat === 0).every(action => ['fold', 'check'].includes(action.label))));
});

test('CLI poker runs a rule-bot baseline without an API key and writes a private log', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-cli-poker-'));
  const emptyEnv = path.join(outputDir, 'empty.env');
  await fs.writeFile(emptyEnv, '');
  const env = { ...process.env, TYPESAFE_API_KEY: '', OPENPOKER_ADDONS: 'off' };
  try {
    const bin = path.join(root, 'bin', 'openpoker.mjs');
    const result = await execFile(process.execPath, [bin, '--auto', '--opponent', 'rule', '--hands', '20', '--seed', '5', '--env-file', emptyEnv, '--output-dir', outputDir, '--format', 'json'], { cwd: root, env, timeout: 60_000 });
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema_version, 'jev/poker-match/v1');
    assert.deepEqual([report.opponent, report.hands_played, report.illegal_actions, report.duplicate_deals], ['rule', 20, 0, true]);
    assert.equal(report.log, undefined, 'the printed summary omits the hand log');
    assert.equal(report.jev, undefined);
    const stat = await fs.stat(report.artifacts.json);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(JSON.parse(await fs.readFile(report.artifacts.json, 'utf8')).log.length, 20);
    await assert.rejects(
      () => execFile(process.execPath, [bin, '--auto', '--hands', '21'], { cwd: root, env }),
      error => error.code === 2 && /even --hands/.test(error.stderr)
    );
    await assert.rejects(
      () => execFile(process.execPath, [bin, '--opponent', 'jev', '--hands', '2', '--env-file', emptyEnv], { cwd: root, env }),
      error => error.code === 1 && /MISSING_API_KEY/.test(error.stderr)
    );
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('CLI poker --auto keeps 200 chips and 1/2 blinds, times every action, and refuses bad blinds or web-only options', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-cli-poker-'));
  const emptyEnv = path.join(outputDir, 'empty.env');
  await fs.writeFile(emptyEnv, '');
  const env = { ...process.env, TYPESAFE_API_KEY: '', OPENPOKER_ADDONS: 'off' };
  const bin = path.join(root, 'bin', 'openpoker.mjs');
  const common = ['--seed', '5', '--env-file', emptyEnv, '--output-dir', outputDir];
  const run = async (...args) => JSON.parse((await execFile(process.execPath, [bin, ...args, ...common], { cwd: root, env, timeout: 60_000 })).stdout);
  const usage = async (args, message) => await assert.rejects(
    () => execFile(process.execPath, [bin, ...args, ...common], { cwd: root, env, timeout: 60_000 }),
    error => error.code === 2 && JSON.parse(error.stderr).code === 'USAGE' && message.test(error.stderr),
    args.join(' ')
  );
  try {
    // The measured baseline is unchanged: 100 big blinds of 2, two seats, mirrored deals.
    const report = await run('--auto', '--opponent', 'rule', '--hands', '4', '--format', 'json');
    assert.deepEqual([report.starting_stack, report.blinds, report.seats, report.hands_played], [200, { small: 1, big: 2 }, 2, 4]);
    assert.deepEqual([report.mode, report.duplicate_deals, report.reset_stacks, report.decision_timeout_ms, report.illegal_actions], ['auto', true, true, 0, 0]);
    for (const player of report.players) {
      assert.ok(Number.isInteger(player.think_ms_total) && player.think_ms_total >= 0, 'each player has a reasoning total');
      assert.ok(player.think_ms_max >= player.think_ms_mean && player.think_ms_total >= player.think_ms_max);
    }
    const saved = JSON.parse(await fs.readFile(report.artifacts.json, 'utf8'));
    const actions = saved.log.flatMap(hand => hand.actions);
    assert.ok(actions.length > 0 && actions.every(action => Number.isInteger(action.think_ms) && action.think_ms >= 0), 'every logged action carries think_ms');
    // Chips and blinds can still be chosen for a measured match.
    const custom = await run('--auto', '--hands', '2', '--stack', '1000', '--blinds', '5/10', '--format', 'json');
    assert.deepEqual([custom.starting_stack, custom.blinds], [1000, { small: 5, big: 10 }]);

    await usage(['--auto', '--hands', '4', '--blinds', '100/50'], /--blinds needs SMALL\/BIG/);
    await usage(['--auto', '--hands', '4', '--blinds', '0/2'], /--blinds needs SMALL\/BIG/);
    await usage(['--auto', '--hands', '4', '--blinds', '2'], /--blinds needs SMALL\/BIG/);
    await usage(['--auto', '--hands', '4', '--blinds', '1/2/4'], /--blinds needs SMALL\/BIG/);
    await usage(['--auto', '--hands', '4', '--stack', '100', '--blinds', '30/60'], /at least two big blinds/);
    await usage(['--auto', '--hands', '4', '--stack', '1000001'], /--stack must be an integer from 1 to 1000000/);
    // Seats, models and the turn clock belong to the browser table.
    await usage(['--players', 'you,bot'], /--players requires --web/);
    await usage(['--auto', '--hands', '4', '--players', 'you,bot'], /--players requires --web/);
    await usage(['--turn-limit', '30'], /--turn-limit requires --web/);
    await usage(['--claude-model', 'sonnet'], /--claude-model requires --web/);
    await usage(['--antigravity-model', 'gemini-3.8-flash-low'], /Unknown option: --antigravity-model/);
    await usage(['--tunnel'], /--tunnel requires --web/);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('CLI poker --web deals 10,000 chips at 50/100 to the seats and models named in --players', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-cli-poker-web-'));
  const emptyEnv = path.join(dir, 'empty.env');
  await fs.writeFile(emptyEnv, '');
  // The table asks each command-line tool for its version. Only this folder is on the child's
  // PATH, so it finds a stand-in for `claude`, no `codex`, and can never start the real tools.
  const tools = path.join(dir, 'tools');
  await fs.mkdir(tools);
  await fs.writeFile(path.join(tools, 'claude'), '#!/bin/sh\necho "0.0.0 (test stand-in)"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: tools, TYPESAFE_API_KEY: '', OPENPOKER_ADDONS: 'off' };
  const bin = path.join(root, 'bin', 'openpoker.mjs');
  // Port 0 asks the system for a free port.
  const common = ['--port', '0', '--env-file', emptyEnv, '--output-dir', dir];
  const usage = async (args, message) => await assert.rejects(
    () => execFile(process.execPath, [bin, '--web', ...args, ...common], { cwd: root, env, timeout: 60_000 }),
    error => error.code === 2 && message.test(error.stderr),
    args.join(' ')
  );
  // Starts the table and resolves with its address once the command has printed it.
  const children = [];
  const serve = async (...args) => {
    const child = spawn(process.execPath, [bin, '--web', ...args, ...common], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const table = { child, stdout: '', stderr: '', exited: new Promise(resolve => child.on('close', code => resolve(code))) };
    children.push(child);
    table.url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The table did not start: ${table.stderr || table.stdout}`)), 30_000);
      const settle = (done, value) => {
        clearTimeout(timer);
        done(value);
      };
      child.stderr.on('data', chunk => { table.stderr += chunk; });
      child.stdout.on('data', chunk => {
        table.stdout += chunk;
        const started = table.stdout.match(/Poker table: (http:\/\/127\.0\.0\.1:\d+)\n/);
        if (started) settle(resolve, started[1]);
      });
      child.on('close', code => settle(reject, new Error(`The table exited with ${code}: ${table.stderr}`)));
    });
    assert.doesNotMatch(table.url, /:(8787|8790)$/);
    return table;
  };
  try {
    await usage(['--players', 'you'], /--players needs two to six/);
    await usage(['--players', 'you,bot,bot,bot,bot,bot,bot'], /--players needs two to six/);
    await usage(['--players', 'you,wizard'], /--players needs two to six/);
    await usage(['--players', 'bot,you'], /list yourself first/);
    await usage(['--players', 'you,bot', '--turn-limit', '601'], /--turn-limit must be 0 \(no limit\) to 600 seconds/);
    await usage(['--players', 'you,bot', '--turn-limit', '1.5'], /--turn-limit must be/);
    await usage(['--players', 'you,bot', '--blinds', '100/50'], /--blinds needs SMALL\/BIG/);
    await usage(['--players', 'you,bot', '--auto'], /cannot be combined with --auto/);

    // A model name may hold colons: only the first colon separates it from the player type.
    const [named, chosen] = await Promise.all([
      serve('--players', 'You,claude:a:b,bot', '--turn-limit', '45', '--hands', '3', '--seed', '7'),
      serve('--stack', '5000', '--blinds', '25/50', '--turn-limit', '0')
    ]);
    const state = await (await fetch(`${named.url}/state`)).json();
    assert.deepEqual(state.settings, { hands: 3, stack: 10_000, small_blind: 50, big_blind: 100, turn_limit_ms: 45_000, max_seats: 6 });
    assert.deepEqual(state.players.map(player => [player.type, player.model, player.name]), [['human', null, 'You'], ['claude', 'a:b', 'Claude · a:b'], ['rule', null, 'Bot']]);
    assert.deepEqual([state.seed, state.spectator, state.hand.number, state.hand.acting], [7, false, 1, 0], 'the game starts at once, with the person first to act');
    assert.deepEqual([state.hand.stacks, state.hand.bets], [[10_000, 9_950, 9_900], [0, 50, 100]]);
    const types = Object.fromEntries(state.player_types.map(type => [type.id, type]));
    assert.deepEqual(Object.keys(types), ['human', 'jev', 'claude', 'codex', 'opencode', 'rule', 'agent', 'friend']);
    assert.deepEqual([types.friend.available, types.friend.category], [false, 'friend'], 'friends need --lan');
    assert.equal(types.learner, undefined, 'the Learner is an add-on, and this table runs without it');
    assert.equal(state.brand, 'OpenPoker', 'the public edition carries its own name');
    assert.equal(types.opencode.available, false, 'the stand-in PATH holds no opencode');
    assert.equal(types.antigravity, undefined, 'Antigravity is not offered in the public edition');
    assert.deepEqual(['claude', 'codex', 'opencode', 'rule'].map(id => types[id].slow), [true, true, true, false], 'tools that think for seconds are marked slow for the clock warning');
    assert.deepEqual([types.claude.available, types.codex.available, types.jev.available], [true, false, false], 'only the stand-in was found');
    assert.deepEqual([types.human.models, types.rule.models, types.agent.models, Array.isArray(types.claude.models), Array.isArray(types.jev.models), types.codex.models], [null, null, null, true, true, []]);

    // Chips, blinds and "no limit" chosen on the command line; with no seats named, the page asks for them.
    const waiting = await (await fetch(`${chosen.url}/state`)).json();
    assert.deepEqual(waiting.settings, { hands: 20, stack: 5000, small_blind: 25, big_blind: 50, turn_limit_ms: 0, max_seats: 6 });
    assert.deepEqual([waiting.status, waiting.players, waiting.hand], ['idle', [], null]);

    named.child.kill('SIGINT');
    assert.equal(await named.exited, 0, named.stderr);
    assert.match(named.stdout, /Play chips only/);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['empty.env', 'tools'], 'a game with no finished hand writes no log');
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('openpoker doctor reports what is ready without reading a key aloud', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openpoker-doctor-'));
  const tools = await fs.mkdtemp(path.join(os.tmpdir(), 'openpoker-tools-'));
  try {
    // A stand-in claude and node on an otherwise empty PATH: only claude is found, even where node's own folder holds other tools.
    await fs.writeFile(path.join(tools, 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
    await fs.symlink(process.execPath, path.join(tools, 'node'));
    const env = { ...process.env, PATH: tools, TYPESAFE_API_KEY: 'test-key-not-real', OPENPOKER_ADDONS: 'off' };
    const bin = path.join(root, 'bin', 'openpoker.mjs');
    const { stdout } = await execFile(process.execPath, [bin, 'doctor', '--port', '58787', '--output-dir', outputDir, '--format', 'json'], { cwd: root, env });
    const report = JSON.parse(stdout);
    assert.equal(report.schema_version, 'openpoker/doctor/v1');
    assert.equal(report.node.ready, Number(process.versions.node.split('.')[0]) >= 20);
    assert.deepEqual([report.players.claude.ready, report.players.claude.version], [true, '9.9.9 (Claude Code)']);
    assert.deepEqual([report.players.codex.ready, report.players.opencode.ready, report.players.antigravity, report.friends.tunnel.ready], [false, false, undefined, false]);
    assert.equal(report.players.jev.ready, true);
    assert.ok(!stdout.includes('test-key-not-real'), 'the key itself is never printed');
    assert.deepEqual(report.addons, []);
    assert.equal(report.data.folder, outputDir);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.rm(tools, { recursive: true, force: true });
  }
});
