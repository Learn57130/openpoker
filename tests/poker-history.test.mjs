import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeRunId } from '../src/lib/files.mjs';
import { seededRandom } from '../src/cards.mjs';
import { createGameHistory } from '../src/game-history.mjs';
import { writePokerLog } from '../src/log.mjs';
import { createRulePlayer } from '../src/players.mjs';
import { startTableServer } from '../src/server.mjs';
import { createTable } from '../src/table-session.mjs';

const PLAYER_TYPES = Object.freeze([
  { id: 'human', name: 'You', available: true },
  { id: 'rule', name: 'Bot', available: true }
]);

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'jev-poker-history-'));
}

// One logged hand in the match log's own form.
function loggedHand({ number, button = 0, hole, actions, board = [], reason, winners, pot = 200, handNames = hole.map(() => null) }) {
  return {
    hand_number: number,
    button,
    starting_stacks: hole.map(() => 10_000),
    hole_cards: hole,
    actions: actions.map(([seat, street, label, amount = 0, to = 0, meta = {}]) => ({ street, seat, label, amount, to, think_ms: 1200, meta })),
    board,
    result: { reason, winner: winners[0], winners, pot, pots: [{ amount: pot, eligible: hole.flatMap((cards, seat) => (cards ? [seat] : [])), winners }], net: hole.map((_, seat) => (winners.includes(seat) ? pot / 2 : -pot / 2)), hand_names: handNames }
  };
}

// Two hands: one won by a fold, one shown down. Seat 1 folds the first.
const HANDS = [
  loggedHand({
    number: 1,
    hole: [['Ah', 'Kd'], ['7c', '2s']],
    actions: [[0, 'preflop', 'raise_small', 150, 200, { source: 'agent', model: 'model-a', reply: 'IGNORE THIS REPLY' }], [1, 'preflop', 'fold', 0, 0, { source: 'agent', note: 'IGNORE THIS NOTE' }]],
    reason: 'fold',
    winners: [0]
  }),
  loggedHand({
    number: 2,
    button: 1,
    hole: [['Qs', 'Qh'], ['9d', '9c']],
    actions: [[1, 'preflop', 'call', 50, 100, { source: 'fallback', reason: 'timeout' }], [0, 'preflop', 'check', 0, 100, { source: 'jev', confidence: 0.91 }], [0, 'flop', 'check'], [1, 'flop', 'check', 0, 0, { source: 'fallback', reason: 'unclear' }]],
    board: ['2c', '5d', 'Jh', '8s', '3c'],
    reason: 'showdown',
    winners: [0],
    handNames: ['one pair', 'one pair']
  })
];

function report({ runId, mode, seats, names, createdAt, hands = HANDS }) {
  return {
    schema_version: 'jev/poker-match/v1',
    status: 'complete',
    run_id: runId,
    created_at: createdAt,
    mode,
    duration_ms: 60_000,
    stop_reason: 'hands_complete',
    hands_played: hands.length,
    ...(seats ? { seats: seats.map(type => ({ type, model: null })) } : {}),
    blinds: { small: 50, big: 100 },
    starting_stack: 10_000,
    decision_timeout_ms: 30_000,
    final_stacks: [10_200, 9_800],
    players: names.map((name, seat) => ({ seat, name, kind: seats?.[seat] ?? (seat === 0 ? 'human' : 'rule'), net_chips: seat === 0 ? 200 : -200 })),
    log: hands
  };
}

async function writeLog(directory, value) {
  await fs.writeFile(path.join(directory, `${value.run_id}.json`), JSON.stringify(value));
}

const ids = {
  person: '2026-10-01T09-00-00-000Z-0000000a',
  watched: '2026-10-01T10-00-00-000Z-0000000b',
  terminal: '2026-10-01T08-00-00-000Z-0000000c',
  auto: '2026-10-01T11-00-00-000Z-0000000d',
  broken: '2026-10-01T12-00-00-000Z-0000000e'
};

async function savedGames() {
  const directory = await tempDir();
  await writeLog(directory, report({ runId: ids.person, mode: 'web', seats: ['human', 'rule'], names: ['You', 'Bot'], createdAt: '2026-10-01T09:00:00.000Z' }));
  await writeLog(directory, report({ runId: ids.watched, mode: 'web', seats: ['model', 'jev'], names: ['Model', 'Jev'], createdAt: '2026-10-01T10:00:00.000Z' }));
  await writeLog(directory, report({ runId: ids.terminal, mode: 'interactive', names: ['You', 'Rule bot'], createdAt: '2026-10-01T08:00:00.000Z' }));
  await writeLog(directory, report({ runId: ids.auto, mode: 'auto', names: ['Rule bot (baseline)', 'Rule bot'], createdAt: '2026-10-01T11:00:00.000Z' }));
  await fs.writeFile(path.join(directory, `${ids.broken}.json`), '{ not json');
  await fs.writeFile(path.join(directory, 'personas.json'), JSON.stringify({ schema_version: 'jev/poker-personas/v1', personas: [] }));
  await fs.writeFile(path.join(directory, 'notes.txt'), 'not a game');
  return directory;
}

test('the game list shows table and terminal games newest first and leaves out --auto runs and other files', async () => {
  const directory = await savedGames();
  const history = createGameHistory({ directory });
  const games = await history.list();
  assert.deepEqual(games.map(game => game.id), [ids.watched, ids.person, ids.terminal]);
  assert.deepEqual(games.map(game => game.source), ['table', 'table', 'terminal']);
  assert.deepEqual(games.map(game => game.spectator), [true, false, false]);
  const person = games[1];
  assert.equal(person.started_at, '2026-10-01T08:59:00.000Z', 'the start is the end less the duration');
  assert.deepEqual([person.hands_played, person.winner_seat, person.turn_limit_ms, person.stop_reason, person.in_progress], [2, 0, 30_000, 'hands_complete', false]);
  assert.deepEqual(person.players.map(player => [player.name, player.type, player.net_chips, player.final_stack]), [['You', 'human', 200, 10_200], ['Bot', 'rule', -200, 9_800]]);
  // A log that did not parse, as when it is caught while being written, is read again next time.
  await writeLog(directory, report({ runId: ids.broken, mode: 'web', seats: ['human', 'rule'], names: ['You', 'Bot'], createdAt: '2026-10-01T12:00:00.000Z' }));
  assert.equal((await history.list())[0].id, ids.broken);
  // A missing directory is an empty history, not an error.
  assert.deepEqual(await createGameHistory({ directory: path.join(await tempDir(), 'none') }).list(), []);
});

test('a hand shows what the table showed: the person\'s cards and showdown cards, never a folded hand', async () => {
  const history = createGameHistory({ directory: await savedGames() });
  const person = await history.get(ids.person);
  assert.deepEqual(person.hands[0].cards, [['Ah', 'Kd'], null], 'the folded seat\'s cards stay hidden');
  assert.deepEqual(person.hands[1].cards, [['Qs', 'Qh'], ['9d', '9c']], 'both seats showed down');
  assert.deepEqual(person.hands[1].result.hand_names, ['one pair', 'one pair']);
  assert.deepEqual(person.hands[1].board, ['2c', '5d', 'Jh', '8s', '3c']);

  // Nobody sat down, so every hand was face up.
  const watched = await history.get(ids.watched);
  assert.deepEqual(watched.hands[0].cards, [['Ah', 'Kd'], ['7c', '2s']]);
  assert.deepEqual(watched.hands[0].result.hand_names, [null, null], 'a hand that was not shown down has no hand name');

  // The terminal game seats the person at seat 0.
  assert.deepEqual((await history.get(ids.terminal)).hands[0].cards, [['Ah', 'Kd'], null]);
});

test('each action carries its time and flags, and no model reply or agent note', async () => {
  const history = createGameHistory({ directory: await savedGames() });
  const game = await history.get(ids.person);
  const [raise, fold] = game.hands[0].actions;
  assert.deepEqual(raise, { seat: 0, street: 'preflop', label: 'raise_small', amount: 150, to: 200, think_ms: 1200, timed_out: false, stand_in: false, model: 'model-a', confidence: null });
  assert.equal(fold.label, 'fold');
  const [late, jev, , standIn] = game.hands[1].actions;
  assert.deepEqual([late.timed_out, late.stand_in], [true, false]);
  assert.equal(jev.confidence, 0.91);
  assert.deepEqual([standIn.timed_out, standIn.stand_in], [false, true]);
  const text = JSON.stringify(game);
  assert.ok(!text.includes('IGNORE THIS'), 'untrusted text never reaches the history');
  assert.ok(!text.includes('"note"') && !text.includes('"reply"'));
});

test('a game id is checked before any file is read', async () => {
  const history = createGameHistory({ directory: await savedGames() });
  for (const bad of ['../personas', 'personas', `${ids.person}/..`, '', null]) {
    await assert.rejects(history.get(bad), error => error.code === 'INVALID_INPUT', String(bad));
  }
  for (const missing of [ids.auto, ids.broken, '2026-10-01T13-00-00-000Z-0000000f']) {
    await assert.rejects(history.get(missing), error => error.code === 'GAME_NOT_FOUND', missing);
  }
});

// A person against a bot. The table writes its logs to `<outputDir>/poker`, where the history reads them.
async function openTable({ withHistory = true, hands = 2 } = {}) {
  const outputDir = await tempDir();
  const table = createTable({
    playerTypes: PLAYER_TYPES,
    createPlayer: (type, context) => createRulePlayer({ name: 'Bot', random: seededRandom(context.seed + 1), iterations: 40 }),
    defaultPlayers: ['human', 'rule'],
    hands,
    seed: 5,
    botDelayMs: 0,
    turnLimitMs: 0,
    gameHistory: withHistory ? createGameHistory({ directory: path.join(outputDir, 'poker') }) : null,
    onMatchEnd: async (match, context) => await writePokerLog({ schema_version: 'jev/poker-match/v1', run_id: makeRunId(), created_at: new Date().toISOString(), mode: 'web', duration_ms: 1000, seats: context.seats, ...match }, outputDir)
  });
  const server = await startTableServer({ table, port: 0 });
  const get = async route => {
    const response = await fetch(`${server.url}${route}`);
    return { status: response.status, body: await response.json() };
  };
  const post = async (route, body = {}) => {
    const response = await fetch(`${server.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const until = (predicate, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('the table did not reach the expected state'));
    }, timeoutMs);
    const check = () => {
      const state = table.snapshot();
      if (!predicate(state)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(state);
    };
    const unsubscribe = table.subscribe(check);
    check();
  });
  // The person folds, or checks when a fold is not offered, until the hand is over.
  async function playHand() {
    for (;;) {
      const state = await until(view => ['your_turn', 'hand_over', 'match_over'].includes(view.status));
      if (state.status !== 'your_turn') return state;
      const labels = state.hand.legal_actions.map(action => action.label);
      await post('/action', { label: labels.includes('fold') ? 'fold' : 'check' });
      await until(view => view.status !== 'your_turn' || view.hand.log.length > state.hand.log.length);
    }
  }
  return { table, server, get, post, until, playHand };
}

test('the game being played is listed first with its finished hands, then gives way to its saved log', async () => {
  const { table, server, get, post, until, playHand } = await openTable();
  try {
    assert.equal(table.snapshot().history_enabled, true);
    assert.deepEqual((await get('/games')).body, { current: null, games: [] });
    assert.deepEqual([(await get('/games/current')).status, (await get('/games/current')).body.code], [404, 'GAME_NOT_FOUND']);

    await post('/new', { players: ['human', 'rule'] });
    const first = await playHand();
    assert.equal(first.status, 'hand_over');
    const listed = (await get('/games')).body;
    assert.deepEqual([listed.current.id, listed.current.in_progress, listed.current.hands_played, listed.current.ended_at], ['current', true, 1, null]);
    assert.deepEqual(listed.current.players.map(player => player.name), ['You', 'Bot']);
    const live = (await get('/games/current')).body.game;
    assert.equal(live.hands.length, 1);
    const hand = live.hands[0];
    assert.ok(hand.cards[0], 'the person\'s own cards');
    if (hand.result.reason === 'fold') assert.equal(hand.cards[1], null, 'the bot\'s cards were never shown');
    assert.deepEqual(hand.actions.map(action => action.label), first.hand.log.map(entry => entry.label));
    assert.equal(JSON.stringify(table.snapshot()).includes('"hole_cards"'), false, 'the page snapshot does not carry the history');

    await post('/next');
    assert.equal((await playHand()).status, 'hand_over');
    // The last hand also waits for "next" before the match ends.
    await post('/next');
    await until(view => view.status === 'match_over');
    await table.finished();
    const after = (await get('/games')).body;
    assert.equal(after.current, null, 'a finished game is no longer in progress');
    assert.equal(after.games.length, 1);
    assert.deepEqual([after.games[0].hands_played, after.games[0].source, after.games[0].spectator], [2, 'table', false]);
    const saved = (await get(`/games/${after.games[0].id}`)).body.game;
    assert.equal(saved.hands.length, 2);
    assert.deepEqual(saved.hands[0].actions, hand.actions);
    assert.deepEqual([(await get('/games/not-a-game')).status, (await get('/games/not-a-game')).body.code], [400, 'INVALID_INPUT']);
  } finally {
    await server.close();
  }
});

test('a table without a game history says so', async () => {
  const { table, server, get } = await openTable({ withHistory: false });
  try {
    assert.equal(table.snapshot().history_enabled, false);
    const response = await get('/games');
    assert.deepEqual([response.status, response.body.code], [404, 'HISTORY_DISABLED']);
  } finally {
    await server.close();
  }
});
