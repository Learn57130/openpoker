import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPersonaStore, PERSONA_LIMITS } from '../src/persona-store.mjs';
import { createRulePlayer, createScriptedPlayer } from '../src/players.mjs';
import { places, ratingChanges } from '../src/ranking.mjs';
import { startTableServer } from '../src/server.mjs';
import { createTable } from '../src/table-session.mjs';

const PLAYER_TYPES = [
  { id: 'human', name: 'You', category: 'human', available: true },
  { id: 'rule', name: 'Bot', category: 'bot', available: true, styles: true },
  { id: 'model', name: 'Model', category: 'agent', available: true, models: [], reasoning: true, styles: true, style_notes: true },
  { id: 'offline', name: 'Offline', category: 'agent', available: false, unavailable_reason: 'not installed' }
];

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-personas-'));
  const file = path.join(directory, 'poker', 'personas.json');
  try {
    await run({ file, store: createPersonaStore({ file }) });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function makeTable(store, extra = {}) {
  return createTable({
    playerTypes: PLAYER_TYPES,
    createPlayer: async (type, context) => createRulePlayer({ name: type, iterations: 20, style: context.style }),
    personaStore: store,
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
  for (let guard = 0; guard < 400; guard += 1) {
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

test('the persona store keeps names unique, ranks by rating, and logs every match', async () => {
  await withStore(async ({ file, store }) => {
    assert.deepEqual(await store.list(), []);
    const ace = await store.create({ name: '  Ace   High ', seat: { type: 'rule', style: 'tight_aggressive' } });
    assert.deepEqual([ace.name, ace.type, ace.style, ace.rating, ace.rank, ace.matches, ace.bb_per_100, ace.win_rate, ace.avg_think_ms, ace.last_played_at], ['Ace High', 'rule', 'tight_aggressive', 1000, 1, 0, null, null, null, null]);
    assert.equal(ace.history, undefined, 'a list entry carries no history');
    await assert.rejects(() => store.create({ name: 'ace high', seat: { type: 'rule' } }), error => error.code === 'NAME_TAKEN');
    for (const bad of ['', '   ', 'x'.repeat(PERSONA_LIMITS.nameLength + 1), '<b>bold</b>', '-dash', 'two\nlines', 7]) {
      await assert.rejects(() => store.create({ name: bad, seat: { type: 'rule' } }), error => error.code === 'INVALID_INPUT', String(bad));
    }
    const bo = await store.create({ name: "Bo O'Neil", seat: { type: 'model', model: 'provider/m-1', reasoning: false, style_note: 'Slow-play.' } });

    const changes = await store.recordMatch({
      hands: 20,
      big_blind: 10,
      stop_reason: 'hands_complete',
      seats: [
        { persona_id: ace.id, name: 'Ace High', net_chips: -300, decisions: 40, think_ms_total: 400 },
        { persona_id: bo.id, name: "Bo O'Neil", net_chips: 500, decisions: 50, think_ms_total: 100_000 },
        { persona_id: null, name: 'Guest bot', net_chips: -200, decisions: 30, think_ms_total: 30 }
      ]
    });
    assert.deepEqual(changes.map(change => [change.persona_id, change.before]), [[ace.id, 1000], [bo.id, 1000], [null, 1000]]);
    assert.ok(changes[1].after > 1000 && changes[0].after < 1000);
    assert.equal(changes[2].after, 1000, 'a guest is rated but never stored');

    const [first, second] = await store.list();
    assert.deepEqual([first.name, first.rank, second.name, second.rank], ["Bo O'Neil", 1, 'Ace High', 2]);
    assert.deepEqual([first.matches, first.match_wins, first.hands, first.net_chips, first.bb_per_100, first.win_rate, first.avg_think_ms], [1, 1, 20, 500, 250, 1, 2000]);
    assert.deepEqual([second.match_wins, second.bb_per_100, second.win_rate], [0, -150, 0]);
    const detail = await store.get(ace.id);
    assert.equal(detail.history.length, 1);
    const entry = detail.history[0];
    assert.deepEqual([entry.hands, entry.place, entry.of, entry.opponents, entry.net_chips, entry.bb_per_100, entry.rating_before, entry.stop_reason], [20, 3, 3, ["Bo O'Neil", 'Guest bot'], -300, -150, 1000, 'hands_complete']);
    assert.equal(entry.rating_after, detail.rating);
    assert.match(entry.at, /^\d{4}-\d\d-\d\dT/);

    // The file is private, and a second store object reads what the first wrote.
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.deepEqual((await createPersonaStore({ file }).list()).map(persona => persona.name), ["Bo O'Neil", 'Ace High']);

    // Changes made at the same moment do not lose each other.
    await Promise.all(['One', 'Two', 'Three', 'Four'].map(name => store.create({ name, seat: { type: 'rule' } })));
    assert.equal((await store.list()).length, 6);
    assert.deepEqual(await store.remove(ace.id), { removed: true });
    await assert.rejects(() => store.get(ace.id), error => error.code === 'PERSONA_NOT_FOUND');
    await assert.rejects(() => store.remove('missing'), error => error.code === 'PERSONA_NOT_FOUND');
    assert.throws(() => createPersonaStore({ file: 'relative.json' }), /absolute/);
  });
});

test('a saved persona sits under its own name and its rating and history follow the match', async () => {
  await withStore(async ({ store }) => {
    const table = makeTable(store);
    try {
      const rock = await table.createPersona({ name: 'Rocky', type: 'rule', style: 'tight_passive' });
      const wild = await table.createPersona({ name: 'Wild Bill', type: 'rule', style: 'loose_aggressive' });
      await assert.rejects(() => table.createPersona({ name: 'Ghost', type: 'offline' }), error => error.code === 'PLAYER_UNAVAILABLE');
      await assert.rejects(() => table.createPersona({ name: 'Bad', type: 'rule', model: 'x' }), /does not take a model/);
      await assert.rejects(() => table.createPersona({ name: 'Bad', type: 'wizard' }), /Unknown player type/);
      await assert.rejects(() => table.newGame({ players: [{ persona: rock.id }, { persona: rock.id }] }), /cannot sit in two seats/);
      await assert.rejects(() => table.newGame({ players: [{ persona: 'missing' }, 'rule'] }), error => error.code === 'PERSONA_NOT_FOUND');
      const me = await table.createPersona({ name: 'Nat', type: 'human' });
      await assert.rejects(() => table.newGame({ players: ['rule', { persona: me.id }] }), /bottom seat/);

      const state = await table.newGame({ players: [{ persona: rock.id }, { persona: wild.id }, 'rule'] });
      assert.deepEqual(state.players.map(player => [player.name, player.persona?.id ?? null, player.persona?.rating ?? null, player.style?.id ?? null]), [
        ['Rocky', rock.id, 1000, 'tight_passive'], ['Wild Bill', wild.id, 1000, 'loose_aggressive'], ['Bot', null, null, 'balanced']
      ]);
      assert.equal(state.personas_enabled, true);
      await assert.rejects(() => table.removePersona(rock.id), error => error.code === 'PERSONA_IN_USE');

      const over = await playOut(table);
      assert.equal(over.status, 'match_over');
      const match = over.match;
      assert.deepEqual([match.stop_reason, match.hands_played], ['hands_complete', 4]);
      assert.ok(match.duration_ms >= 0);
      assert.deepEqual(match.summary.seats.map(seat => seat.name), ['Rocky', 'Wild Bill', 'Bot']);
      assert.equal(match.summary.seats.reduce((total, seat) => total + seat.net_chips, 0), 0);
      assert.deepEqual(match.summary.seats.map(seat => seat.final_stack), match.final_stacks);
      assert.equal(match.summary.seats.reduce((total, seat) => total + seat.hands_won, 0) >= 4, true, 'every hand has at least one winner');
      assert.ok(match.summary.seats.every(seat => seat.decisions > 0 && seat.timeouts === 0 && seat.stand_ins === 0));
      assert.ok(match.summary.biggest_pot.amount >= 15 && match.summary.biggest_pot.hand_number >= 1);
      assert.ok(match.summary.showdowns >= 0 && match.summary.showdowns <= 4);
      assert.deepEqual(match.ratings.map(change => [change.seat, change.persona_id, change.before]), [[0, rock.id, 1000], [1, wild.id, 1000]]);
      for (const change of match.ratings) assert.equal(over.players[change.seat].persona.rating, change.after);

      const listed = await table.personas();
      const saved = Object.fromEntries(listed.map(persona => [persona.name, persona]));
      assert.deepEqual([saved.Rocky.matches, saved.Rocky.hands, saved['Wild Bill'].matches, saved.Nat.matches], [1, 4, 1, 0]);
      assert.equal(saved.Rocky.rating, match.ratings[0].after);
      assert.equal(saved.Rocky.net_chips, match.net[0]);
      const history = (await table.persona(rock.id)).history;
      assert.deepEqual([history.length, history[0].of, history[0].opponents, history[0].stop_reason], [1, 3, ['Wild Bill', 'Bot'], 'hands_complete']);

      // Dealing again keeps the personas in their seats, now with their new ratings.
      const again = await table.newGame();
      assert.deepEqual(again.players.map(player => player.persona?.rating ?? null), [saved.Rocky.rating, saved['Wild Bill'].rating, null]);
      table.stop();
      await table.finished();
      assert.deepEqual(await table.removePersona(me.id), { removed: true });
    } finally {
      table.stop();
    }
  });
});

test('closing a game ends it at once, keeps the finished hands, and leaves an unplayed game out of the ratings', async () => {
  await withStore(async ({ store }) => {
    const table = makeTable(store, { hands: 50 });
    try {
      await assert.rejects(() => table.close(), error => error.code === 'NOT_RUNNING');
      const a = await table.createPersona({ name: 'Alpha', type: 'rule' });
      const b = await table.createPersona({ name: 'Beta', type: 'rule' });
      await table.newGame({ players: [{ persona: a.id }, { persona: b.id }] });
      for (let played = 0; played < 3; played += 1) {
        while (table.snapshot().status !== 'hand_over') await new Promise(resolve => setImmediate(resolve));
        if (played < 2) table.next();
      }
      const closed = await table.close();
      assert.deepEqual([closed.status, closed.match.stop_reason, closed.match.hands_played], ['match_over', 'closed', 3]);
      assert.equal(closed.match.ratings.length, 2);
      assert.equal((await table.persona(a.id)).history[0].stop_reason, 'closed');
      await assert.rejects(() => table.close(), error => error.code === 'NOT_RUNNING');

      // A game closed before any hand finished changes nothing.
      const human = await table.createPersona({ name: 'Me', type: 'human' });
      await table.newGame({ players: [{ persona: human.id }, { persona: a.id }] });
      while (!['your_turn', 'hand_over'].includes(table.snapshot().status)) await new Promise(resolve => setImmediate(resolve));
      const empty = await table.close();
      assert.deepEqual([empty.match.stop_reason, empty.match.hands_played, empty.match.ratings, empty.match.winner_seat], ['closed', 0, null, null]);
      assert.equal((await table.persona(human.id)).matches, 0);
      assert.equal((await table.persona(a.id)).matches, 1);
    } finally {
      table.stop();
    }
  });
});

test('the persona routes create, list, show and delete over HTTP, and /close ends the game', async () => {
  await withStore(async ({ store }) => {
    const table = makeTable(store, { createPlayer: async () => createScriptedPlayer([]) });
    const server = await startTableServer({ table, port: 0 });
    const call = async (method, route, body) => {
      const response = await fetch(`${server.url}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    try {
      assert.deepEqual((await call('GET', '/personas')).body, { personas: [] });
      const created = await call('POST', '/personas', { name: 'Doyle', type: 'model', model: 'provider/m-2', reasoning: false, style: 'tight_aggressive', style_note: 'Trap.' });
      assert.equal(created.status, 201);
      const doyle = created.body.persona;
      assert.deepEqual([doyle.name, doyle.type, doyle.model, doyle.reasoning, doyle.style, doyle.style_note, doyle.rank], ['Doyle', 'model', 'provider/m-2', false, 'tight_aggressive', 'Trap.', 1]);
      assert.deepEqual([(await call('POST', '/personas', { name: 'doyle', type: 'rule' })).status, (await call('POST', '/personas', { name: '', type: 'rule' })).status], [409, 400]);
      assert.equal((await call('POST', '/personas', { name: 'Odd', type: 'rule', reasoning: false })).body.code, 'INVALID_INPUT');
      assert.deepEqual([(await call('GET', `/personas/${doyle.id}`)).body.persona.history, (await call('GET', '/personas/unknown')).status], [[], 404]);

      assert.equal((await call('POST', '/close', {})).status, 409);
      const started = await call('POST', '/new', { players: ['human', { persona: doyle.id }] });
      assert.deepEqual([started.status, started.body.players[1].name, started.body.players[1].persona.id, started.body.players[1].model], [200, 'Doyle', doyle.id, 'provider/m-2']);
      assert.equal((await call('DELETE', `/personas/${doyle.id}`)).body.code, 'PERSONA_IN_USE');
      const closed = await call('POST', '/close', {});
      assert.deepEqual([closed.status, closed.body.status, closed.body.match.stop_reason], [200, 'match_over', 'closed']);
      assert.deepEqual((await call('DELETE', `/personas/${doyle.id}`)).body, { removed: true });
      assert.equal((await call('DELETE', `/personas/${doyle.id}`)).status, 404);
      const crossSite = await fetch(`${server.url}/personas/x`, { method: 'DELETE', headers: { Origin: 'http://evil.example' } });
      assert.equal(crossSite.status, 403);
    } finally {
      await server.close();
    }
  });
});
