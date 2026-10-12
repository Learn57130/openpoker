import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLeaderboardStore } from '../src/leaderboard-store.mjs';
import { playerKey, playerKeyName } from '../src/lessons.mjs';
import { createRulePlayer, createScriptedPlayer } from '../src/players.mjs';
import { places, ratingChanges } from '../src/ranking.mjs';
import { startTableServer } from '../src/server.mjs';
import { styleById } from '../src/styles.mjs';
import { createTable } from '../src/table-session.mjs';

const PLAYER_TYPES = [
  { id: 'human', name: 'You', category: 'human', available: true },
  { id: 'rule', name: 'Bot', category: 'bot', available: true, styles: true },
  { id: 'model', name: 'Model', category: 'agent', available: true, models: [], reasoning: true, styles: true, style_notes: true },
  { id: 'agent', name: 'Open seat', category: 'agent', available: true },
  { id: 'friend', name: 'Friend', category: 'friend', available: true }
];

async function withDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openpoker-leaderboard-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function makeTable(store, extra = {}) {
  return createTable({
    playerTypes: PLAYER_TYPES,
    createPlayer: async (type, context) => createRulePlayer({ name: type, iterations: 20, style: context.style }),
    leaderboardStore: store,
    hands: 4,
    stack: 1000,
    smallBlind: 5,
    bigBlind: 10,
    seed: 9,
    botDelayMs: 0,
    turnLimitMs: 0,
    ...extra
  });
}

// Drives a game with no human to its end by asking for each next hand.
async function playOut(table) {
  // By time, not by turns: a slow machine needs more turns of the event loop for the same game.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = table.snapshot();
    if (state.status === 'match_over' || state.status === 'error') return state;
    if (state.status === 'hand_over') table.next();
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('the match did not end');
}

test('ratings reward beating stronger players and places share ties', () => {
  assert.deepEqual(ratingChanges([{ rating: 1000, score: 50 }, { rating: 1000, score: -50 }]), [16, -16]);
  const upset = ratingChanges([{ rating: 1000, score: 10 }, { rating: 1400, score: -10 }]);
  assert.ok(upset[0] > 16 && upset[0] === -upset[1], 'beating a higher-rated player earns more');
  assert.deepEqual(ratingChanges([{ rating: 1000, score: 0 }, { rating: 1000, score: 0 }]), [0, 0]);
  const three = ratingChanges([{ rating: 1000, score: 30 }, { rating: 1000, score: 0 }, { rating: 1000, score: -30 }]);
  assert.deepEqual(three, [16, 0, -16]);
  assert.deepEqual(ratingChanges([{ rating: 1000, score: 1 }]), [0]);
  assert.deepEqual(places([30, -10, 30, 0]), [1, 4, 1, 3]);
});

test('a player key is the type and its model, or a bot by its style; friends and open seats have none', () => {
  const type = (id, extra = {}) => ({ ...PLAYER_TYPES.find(candidate => candidate.id === id), ...extra });
  assert.equal(playerKey(type('human')), 'human');
  assert.equal(playerKey(type('model', { model: 'opus', style: styleById('loose_aggressive') })), 'model:opus', 'a model seat is keyed by its model, not its style');
  assert.equal(playerKey(type('model', { model: null })), 'model:default');
  assert.equal(playerKey(type('rule', { style: styleById('tight_passive') })), 'rule:tight_passive');
  assert.equal(playerKey(type('rule', { style: null })), 'rule:balanced');
  assert.equal(playerKey(type('friend')), null);
  assert.equal(playerKey(type('agent')), null);
  assert.equal(playerKeyName(type('model', { model: 'opus' })), 'Model · opus');
  assert.equal(playerKeyName(type('rule', { style: styleById('tight_passive') })), 'Bot · Rock');
  assert.equal(playerKeyName(type('human')), 'You');
});

test('the leaderboard rates by key, sums two seats of one key, stores no guest, and keeps a trend', async () => {
  await withDirectory(async directory => {
    const file = path.join(directory, 'poker', 'leaderboard.json');
    const store = createLeaderboardStore({ file });
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await store.ratings(['model:opus', null]), [1000, 1000]);

    const changes = await store.recordMatch({
      game: 'game-1',
      hands: 20,
      big_blind: 10,
      seats: [
        { key: 'model:opus', name: 'Model · opus', net_chips: 500, decisions: 50, think_ms_total: 100_000 },
        { key: 'rule:balanced', name: 'Bot · Balanced', net_chips: -100, decisions: 40, think_ms_total: 400 },
        { key: 'rule:balanced', name: 'Bot · Balanced', net_chips: -200, decisions: 30, think_ms_total: 300 },
        { key: null, name: 'Mai', net_chips: -200, decisions: 30, think_ms_total: 30 }
      ]
    });
    const expected = ratingChanges([500, -100, -200, -200].map(score => ({ rating: 1000, score })));
    assert.deepEqual(changes.map(change => [change.key, change.before]), [['model:opus', 1000], ['rule:balanced', 1000], ['rule:balanced', 1000], [null, 1000]]);
    assert.equal(changes[0].after, 1000 + expected[0]);
    assert.equal(changes[1].after, 1000 + expected[1] + expected[2], 'a key with two seats moves by the sum of both');
    assert.equal(changes[2].after, changes[1].after);
    assert.equal(changes[3].after, 1000, 'a guest is rated but never stored');

    const [first, second] = await store.list();
    assert.deepEqual([first.key, first.name, first.rank, second.key, second.rank], ['model:opus', 'Model · opus', 1, 'rule:balanced', 2]);
    assert.deepEqual([first.matches, first.match_wins, first.hands, first.net_chips, first.bb_per_100, first.win_rate, first.avg_think_ms], [1, 1, 20, 500, 250, 1, 2000]);
    assert.deepEqual([second.matches, second.match_wins, second.hands, second.net_chips, second.decisions, second.bb_per_100], [1, 0, 40, -300, 70, -75], 'two seats count as one match, with both seats\' hands and chips');
    assert.equal(first.trend, undefined, 'a list entry carries no trend');
    const detail = await store.get('rule:balanced');
    assert.deepEqual(detail.trend.map(point => [point.game, point.rating_before, point.rating_after]), [['game-1', 1000, changes[1].after]]);
    assert.match(detail.trend[0].at, /^\d{4}-\d\d-\d\dT/);
    await assert.rejects(() => store.get('missing'), error => error.code === 'PLAYER_NOT_FOUND');
    assert.deepEqual(await store.ratings(['model:opus', 'rule:balanced', null]), [changes[0].after, changes[1].after, 1000]);

    // The file is private, and a second store object reads what the first wrote.
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).schema_version, 'jev/poker-leaderboard/v1');
    assert.deepEqual((await createLeaderboardStore({ file }).list()).map(entry => entry.key), ['model:opus', 'rule:balanced']);

    // Matches recorded at the same moment do not lose each other.
    await Promise.all([1, 2, 3, 4].map(index => store.recordMatch({ hands: 1, big_blind: 10, seats: [{ key: `model:m${index}`, name: `m${index}`, net_chips: 10 }, { key: 'rule:balanced', name: 'Bot · Balanced', net_chips: -10 }] })));
    assert.equal((await store.list()).length, 6);
    assert.equal((await store.get('rule:balanced')).matches, 5);
    assert.throws(() => createLeaderboardStore({ file: 'relative.json' }), /absolute/);
    await fs.writeFile(file, JSON.stringify({ schema_version: 'jev/poker-leaderboard/v0', players: [] }));
    await assert.rejects(() => store.list(), error => error.code === 'LEADERBOARD_INVALID');
  });
});

test('a game rates every seat by its key, shows each rating on its seat, and leaves an old personas file alone', async () => {
  await withDirectory(async directory => {
    const personas = path.join(directory, 'poker', 'personas.json');
    await fs.mkdir(path.dirname(personas), { recursive: true });
    const old = JSON.stringify({ schema_version: 'jev/poker-personas/v1', personas: [{ id: 'x', name: 'Old' }] });
    await fs.writeFile(personas, old);
    const store = createLeaderboardStore({ file: path.join(directory, 'poker', 'leaderboard.json') });
    const table = makeTable(store);
    try {
      const state = await table.newGame({ players: [{ type: 'rule', style: 'tight_passive' }, { type: 'rule', style: 'loose_aggressive' }, 'rule'] });
      assert.deepEqual(state.players.map(player => [player.name, player.key, player.rating]), [
        ['Bot 1', 'rule:tight_passive', 1000], ['Bot 2', 'rule:loose_aggressive', 1000], ['Bot 3', 'rule:balanced', 1000]
      ]);
      assert.deepEqual([state.leaderboard_enabled, state.learning_enabled, state.personas_enabled], [true, false, undefined]);

      const over = await playOut(table);
      const match = over.match;
      assert.deepEqual([match.stop_reason, match.hands_played], ['hands_complete', 4]);
      assert.ok(match.duration_ms >= 0);
      assert.equal(match.summary.seats.reduce((total, seat) => total + seat.net_chips, 0), 0);
      assert.deepEqual(match.summary.seats.map(seat => seat.final_stack), match.final_stacks);
      assert.ok(match.summary.seats.every(seat => seat.decisions > 0 && seat.timeouts === 0 && seat.stand_ins === 0));
      assert.deepEqual(match.ratings.map(change => [change.seat, change.key, change.before]), [[0, 'rule:tight_passive', 1000], [1, 'rule:loose_aggressive', 1000], [2, 'rule:balanced', 1000]]);
      for (const change of match.ratings) assert.equal(over.players[change.seat].rating, change.after);
      assert.equal(match.reviews, null);

      const listed = Object.fromEntries((await table.leaderboard()).map(entry => [entry.key, entry]));
      assert.deepEqual([listed['rule:tight_passive'].name, listed['rule:tight_passive'].matches, listed['rule:tight_passive'].hands], ['Bot · Rock', 1, 4]);
      assert.equal(listed['rule:balanced'].net_chips, match.net[2]);
      assert.equal((await table.leaderboardEntry('rule:balanced')).trend.length, 1);

      // Dealing again keeps the same seats, now with their new ratings.
      const again = await table.newGame();
      assert.deepEqual(again.players.map(player => player.rating), match.ratings.map(change => change.after));
      table.stop();
      await table.finished();
      assert.equal(await fs.readFile(personas, 'utf8'), old, 'the old personas file is never read, written or deleted');
    } finally {
      table.stop();
    }
  });
});

test('closing a game ends it at once, keeps the finished hands, and leaves an unplayed game out of the ratings', async () => {
  await withDirectory(async directory => {
    const store = createLeaderboardStore({ file: path.join(directory, 'leaderboard.json') });
    const table = makeTable(store, { hands: 50 });
    try {
      await assert.rejects(() => table.close(), error => error.code === 'NOT_RUNNING');
      await table.newGame({ players: ['rule', { type: 'rule', style: 'tight_passive' }] });
      for (let played = 0; played < 3; played += 1) {
        while (table.snapshot().status !== 'hand_over') await new Promise(resolve => setImmediate(resolve));
        if (played < 2) table.next();
      }
      const closed = await table.close();
      assert.deepEqual([closed.status, closed.match.stop_reason, closed.match.hands_played], ['match_over', 'closed', 3]);
      assert.equal(closed.match.ratings.length, 2);
      await assert.rejects(() => table.close(), error => error.code === 'NOT_RUNNING');

      // A game closed before any hand finished changes nothing.
      await table.newGame({ players: ['human', 'rule'] });
      while (!['your_turn', 'hand_over'].includes(table.snapshot().status)) await new Promise(resolve => setImmediate(resolve));
      const empty = await table.close();
      assert.deepEqual([empty.match.stop_reason, empty.match.hands_played, empty.match.ratings, empty.match.winner_seat], ['closed', 0, null, null]);
      assert.deepEqual((await table.leaderboard()).map(entry => [entry.key, entry.matches]).sort(), [['rule:balanced', 1], ['rule:tight_passive', 1]]);
    } finally {
      table.stop();
    }
  });
});

test('the leaderboard routes answer over HTTP, the persona routes are gone, and /close ends the game', async () => {
  await withDirectory(async directory => {
    const store = createLeaderboardStore({ file: path.join(directory, 'leaderboard.json') });
    const table = makeTable(store, { createPlayer: async () => createScriptedPlayer([]) });
    const server = await startTableServer({ table, port: 0 });
    const call = async (method, route, body) => {
      const response = await fetch(`${server.url}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    try {
      assert.deepEqual((await call('GET', '/leaderboard')).body, { players: [] });
      for (const [method, route] of [['GET', '/personas'], ['POST', '/personas'], ['GET', '/personas/abc'], ['DELETE', '/personas/abc']]) {
        assert.equal((await call(method, route, method === 'GET' ? undefined : {})).status, 404, `${method} ${route}`);
      }
      // A seat written as a persona is just a seat with no type now.
      assert.equal((await call('POST', '/new', { players: ['human', { persona: 'abc' }] })).status, 400);
      assert.equal((await call('POST', '/close', {})).status, 409);
      const started = await call('POST', '/new', { players: ['human', { type: 'model', model: 'provider/m-2' }] });
      assert.deepEqual([started.status, started.body.players[1].key, started.body.players[1].rating], [200, 'model:provider/m-2', 1000]);
      const closed = await call('POST', '/close', {});
      assert.deepEqual([closed.status, closed.body.status, closed.body.match.stop_reason], [200, 'match_over', 'closed']);
      assert.equal((await call('GET', `/leaderboard?key=${encodeURIComponent('model:provider/m-2')}`)).status, 404, 'a game closed before any hand rates no one');
      assert.equal((await call('GET', '/notebook')).status, 404, 'a table without a notebook says so');
      const crossSite = await fetch(`${server.url}/close`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
      assert.equal(crossSite.status, 403);
    } finally {
      await server.close();
    }
  });
});
