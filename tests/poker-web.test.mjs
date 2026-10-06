import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createAgentCliAsk, inspectAgentCli } from '../src/agent-cli.mjs';
import { newDeck, seededRandom } from '../src/cards.mjs';
import { seatView, startHand } from '../src/engine.mjs';
import { createModelPlayer, createRulePlayer, createScriptedPlayer, parseAgentLabel } from '../src/players.mjs';
import { startTableServer } from '../src/server.mjs';
import { createTable } from '../src/table-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const SEED = 21;
// The table's own defaults: 10,000 chips, blinds 50/100, 30 seconds (the standard shot clock) for each decision.
const STACK = 10_000;
const SEAT_SCHEMA = 'jev/poker-seat/v2';
const SETTLED = Object.freeze(['your_turn', 'hand_over', 'match_over']);
const PLAYER_TYPES = Object.freeze([
  { id: 'human', name: 'You', available: true },
  { id: 'rule', name: 'Bot', available: true },
  { id: 'agent', name: 'Open seat', available: true },
  { id: 'model', name: 'Model', available: true, models: ['model-a', 'model-b'] },
  { id: 'offline', name: 'Offline', available: false, unavailable_reason: 'not installed' }
]);
const NO_THINKING = Object.freeze({ count: 0, total_ms: 0, mean_ms: null, max_ms: null, last_ms: null });

const sum = values => values.reduce((total, value) => total + value, 0);

// A deck whose dealing order is known: `startHand` pops from the end, button first.
function deckDealing({ button, other, board }) {
  const wanted = [...button, ...other, ...board];
  const rest = newDeck().filter(card => !wanted.includes(card));
  return [...rest, ...wanted.reverse()];
}

// True when the text names the card as a value or a word of its own, not inside a longer word.
function mentionsCard(text, card) {
  return new RegExp(`(^|[^A-Za-z0-9])${card}([^A-Za-z0-9]|$)`).test(text);
}

function withDeadline(promise, timeoutMs, what) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Polls for something no event announces. The ceiling is generous; the usual wait is a few milliseconds.
async function waitFor(predicate, what, timeoutMs = 5000) {
  const giveUp = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < giveUp, `Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// The seats a test gets unless it brings its own: a seeded rule bot, and a "model" that always
// names a legal label and reports the model it was built with.
function createTestPlayer(type, context) {
  const random = seededRandom(context.seed + 1 + context.seat);
  if (type === 'rule') return createRulePlayer({ name: 'Bot', random, iterations: 60 });
  if (type === 'model') return createModelPlayer({ name: 'Model', ask: async () => ({ text: 'check or call', model: context.model ?? 'model-default' }), random, iterations: 60 });
  throw new Error(`No test player for ${type}`);
}

/** One table behind one server on a free port, with the HTTP helpers the tests share. */
async function openTable({ createPlayer = createTestPlayer, ...overrides } = {}) {
  const matches = [];
  const ended = [];
  const built = [];
  const table = createTable({
    playerTypes: PLAYER_TYPES,
    createPlayer: (type, context) => {
      built.push({ type, ...context });
      return createPlayer(type, context);
    },
    hands: 4,
    seed: SEED,
    botDelayMs: 0,
    onMatchEnd: async (match, context) => {
      matches.push(match);
      ended.push(context);
      return null;
    },
    ...overrides
  });
  const server = await startTableServer({ table, port: 0 });
  const read = async response => {
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not every reply is JSON: the page is HTML.
    }
    return { status: response.status, headers: response.headers, text, body };
  };
  return {
    table,
    server,
    matches,
    ended,
    built,
    url: server.url,
    port: server.port,
    get: async route => await read(await fetch(`${server.url}${route}`)),
    post: async (route, body = {}) => await read(await fetch(`${server.url}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })),
    // Waits in-process for a change; the assertions then read the state over HTTP.
    until(predicate, timeoutMs = 10_000) {
      let unsubscribe = () => {};
      const settled = new Promise((resolve, reject) => {
        const check = () => {
          const state = table.snapshot();
          if (state.status === 'error') reject(new Error(`The table stopped on an error: ${state.error.message}`));
          else if (predicate(state)) resolve(state);
        };
        unsubscribe = table.subscribe(check);
        check();
      });
      return withDeadline(settled, timeoutMs, 'the table state').finally(() => unsubscribe());
    }
  };
}

async function withTable(overrides, run) {
  const context = await openTable(overrides);
  try {
    await run(context);
  } finally {
    await context.server.close();
    context.table.stop();
    await context.table.finished();
  }
}

const checkOrCall = state => (state.hand.legal_actions.some(action => action.label === 'check') ? 'check' : 'call');

/** Plays the human seat and deals every next hand over HTTP until the match is over. */
async function playOut({ until, get, post }, { choose = checkOrCall, onReply = () => {} } = {}) {
  for (let step = 0; step < 400; step += 1) {
    await until(state => SETTLED.includes(state.status));
    const polled = await get('/state');
    assert.equal(polled.status, 200);
    onReply(polled);
    const state = polled.body;
    if (state.status === 'match_over') return state;
    const reply = state.status === 'hand_over' ? await post('/next') : await post('/action', { label: choose(state) });
    assert.equal(reply.status, 200, reply.text);
    onReply(reply);
  }
  return assert.fail('the match did not finish');
}

/**
 * The open seat's view once it is that seat's turn. It waits in-process, on the table's own
 * wake-up, so a test can answer before a short turn clock has any chance to run out.
 */
async function seatTurn(table, seat, timeoutMs = 10_000) {
  const giveUp = Date.now() + timeoutMs;
  for (;;) {
    const view = table.seatView(seat);
    if (view.status === 'your_turn') return view;
    assert.ok(['waiting', 'hand_over'].includes(view.status), `seat ${seat} cannot get a turn while it is ${view.status}`);
    assert.ok(Date.now() < giveUp, `Timed out waiting for seat ${seat}'s turn`);
    await table.waitForSeat(seat, 250);
  }
}

// The next seat clockwise from `from` that was dealt into the hand.
function nextDealtIn(dealtIn, from) {
  for (let step = 1; step <= dealtIn.length; step += 1) {
    const seat = (from + step) % dealtIn.length;
    if (dealtIn[seat]) return seat;
  }
  return assert.fail('nobody was dealt in');
}

// What `players[i].think` must read after a seat has taken these decision times, in order.
function thinkingOf(times) {
  if (!times.length) return NO_THINKING;
  return { count: times.length, total_ms: sum(times), mean_ms: Math.round(sum(times) / times.length), max_ms: Math.max(...times), last_ms: times.at(-1) };
}

// `fetch` cannot set Host and should not be trusted to pass Origin through, so these go raw.
function rawRequest(port, { method = 'GET', route = '/state', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: route, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Left as text.
        }
        resolve({ status: response.statusCode, headers: response.headers, text, body: parsed });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('web table: a human plays the rule bot to the end over HTTP and never sees hidden cards', async () => {
  await withTable({ hands: 4 }, async context => {
    const { table, url, get, post, matches } = context;

    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /^<!doctype html>/i);

    const idle = await get('/state');
    assert.equal(idle.status, 200);
    assert.match(idle.headers.get('content-type'), /^application\/json/);
    assert.equal(idle.headers.get('cache-control'), 'no-store');
    assert.deepEqual([idle.body.status, idle.body.hand, idle.body.players], ['idle', null, []]);
    assert.deepEqual(idle.body.settings, { hands: 4, stack: STACK, small_blind: 50, big_blind: 100, turn_limit_ms: 30_000, max_seats: 6 });
    assert.deepEqual(
      idle.body.player_types.map(type => [type.id, type.available, type.models]),
      PLAYER_TYPES.map(type => [type.id, type.available, type.models ?? null]),
      'the page learns which player types take a model'
    );

    // Every version the page could have fetched, not only the ones this test polls.
    const seen = [];
    const unsubscribe = table.subscribe(() => seen.push(JSON.stringify(table.snapshot())));
    const started = await post('/new', { players: ['human', 'rule'] });
    assert.equal(started.status, 200);
    assert.deepEqual([started.body.seed, started.body.spectator], [SEED, false]);
    assert.deepEqual(started.body.players.map(({ seat, type, name, model }) => [seat, type, name, model]), [[0, 'human', 'You', null], [1, 'rule', 'Bot', null]]);

    const finishedHands = new Map();
    // Fold the first hand so one hand ends without a showdown, then check or call to the river.
    const final = await playOut(context, {
      choose: state => (state.hand.number === 1 ? 'fold' : checkOrCall(state)),
      onReply: ({ text, body }) => {
        seen.push(text);
        if (body.status !== 'hand_over') return;
        finishedHands.set(body.hand.number, body.hand);
        assert.equal(body.hand.decisions[0], null, 'the human seat has no recap');
        assert.ok(body.hand.decisions[1].every(decision => decision.source === 'rule'));
        assert.deepEqual(body.hand.legal_actions, []);
      }
    });
    unsubscribe();
    await table.finished();

    assert.equal(matches.length, 1);
    const [match] = matches;
    assert.equal(final.status, 'match_over');
    assert.equal(match.illegal_actions, 0);
    assert.ok(match.hands_played >= 2);
    assert.deepEqual([match.starting_stack, match.blinds], [STACK, { small: 50, big: 100 }]);
    assert.deepEqual([final.match.stop_reason, final.match.hands_played], [match.stop_reason, match.hands_played]);
    assert.deepEqual(final.match.net, match.players.map(player => player.net_chips));
    assert.equal(final.match.net[0] + final.match.net[1], 0);
    assert.deepEqual([final.totals.hands_played, final.totals.net], [match.hands_played, final.match.net]);
    assert.deepEqual(match.players.map(player => player.kind), ['human', 'rule']);
    assert.ok(match.log.every(hand => hand.actions.filter(action => action.seat === 0).every(action => action.meta.source === 'human')));

    assert.deepEqual([match.log[0].result.reason, match.log[0].result.winner], ['fold', 1]);
    const folded = finishedHands.get(1);
    assert.deepEqual([folded.result.reason, folded.result.showdown, folded.cards[1], folded.hand_names[1]], ['fold', false, null, null]);

    let hidden = 0;
    let revealed = 0;
    for (const text of seen) {
      const { hand } = JSON.parse(text);
      if (!hand) continue;
      const [bottomCards, topCards] = match.log[hand.number - 1].hole_cards;
      assert.deepEqual(hand.cards[0], bottomCards, 'the human always sees their own cards');
      // With two players the button posts the small blind, and it changes hands every hand.
      const button = (hand.number - 1) % 2;
      assert.deepEqual([hand.button_seat, hand.small_blind_seat, hand.big_blind_seat], [button, button, 1 - button], `hand ${hand.number}`);
      if (hand.result?.showdown) {
        assert.deepEqual(hand.cards[1], topCards, 'a showdown turns the top seat\'s cards over');
        revealed += 1;
        continue;
      }
      assert.equal(hand.cards[1], null, `hand ${hand.number}: the top seat's cards stay hidden before a showdown`);
      for (const card of topCards) assert.ok(!mentionsCard(text, card), `hand ${hand.number}: the state must not contain ${card}`);
      hidden += 1;
    }
    assert.ok(hidden > 0 && revealed > 0, 'the match covered hidden states and at least one showdown');
  });
});

test('web table: illegal and out-of-turn actions are refused and leave the hand untouched', async () => {
  await withTable({ hands: 2 }, async context => {
    const { get, post, until, matches, table } = context;
    const early = await post('/action', { label: 'call' });
    assert.deepEqual([early.status, early.body.code], [409, 'NOT_YOUR_TURN']);

    await post('/new', { players: ['human', 'rule'] });
    const turn = await until(state => state.status === 'your_turn');
    const legal = turn.hand.legal_actions.map(action => action.label);
    assert.deepEqual(legal, ['fold', 'call', 'raise_small', 'raise_large', 'all_in']);

    // `check` is a real label that is not legal against the big blind; the others are not labels.
    for (const body of [{ label: 'check' }, { label: 'take_the_pot' }, { label: 7 }, {}]) {
      const refused = await post('/action', body);
      assert.deepEqual([refused.status, refused.body.code], [400, 'ILLEGAL_ACTION'], JSON.stringify(body));
      assert.match(refused.body.error, /not legal/);
    }
    const tooSoon = await post('/next');
    assert.deepEqual([tooSoon.status, tooSoon.body.code], [409, 'NOT_WAITING']);
    const unchanged = (await get('/state')).body;
    assert.deepEqual([unchanged.status, unchanged.hand.log, unchanged.hand.legal_actions], ['your_turn', [], turn.hand.legal_actions]);

    assert.equal((await post('/action', { label: 'fold' })).status, 200);
    await until(state => state.status === 'hand_over');
    const late = await post('/action', { label: 'call' });
    assert.deepEqual([late.status, late.body.code], [409, 'NOT_YOUR_TURN']);

    const final = await playOut(context);
    await table.finished();
    assert.equal(final.status, 'match_over');
    assert.equal(matches[0].illegal_actions, 0, 'a refused label never reaches the engine');
    assert.equal(matches[0].hands_played, 2);
    const over = await post('/next');
    assert.deepEqual([over.status, over.body.code], [409, 'NOT_WAITING']);
  });
});

test('web table: unknown hosts, cross-site writes, and non-JSON bodies are refused', async () => {
  await withTable({ hands: 2 }, async ({ table, port, url, get, until }) => {
    await table.newGame({ players: ['human', 'rule'] });
    await until(state => state.status === 'your_turn');
    const json = { 'Content-Type': 'application/json' };

    for (const route of ['/', '/state', '/events', '/seats/1/view', '/seats/5/view']) {
      const rebound = await rawRequest(port, { route, headers: { Host: 'evil.example' } });
      assert.deepEqual([rebound.status, rebound.body.error], [403, 'Unknown host'], route);
      assert.ok(!rebound.text.includes('<html'), 'the page is not served to an unknown host');
    }
    assert.equal((await rawRequest(port, { headers: { Host: `127.0.0.1:${port + 1}` } })).status, 403, 'another port is another host');
    assert.equal((await rawRequest(port, { headers: { Host: `evil.example:${port}` } })).status, 403);
    assert.equal((await rawRequest(port, { headers: { Host: `localhost:${port}` } })).status, 200);
    assert.equal((await rawRequest(port, { headers: { Host: `127.0.0.1:${port}` } })).status, 200);

    const body = JSON.stringify({ label: 'fold' });
    for (const origin of ['http://evil.example', `https://127.0.0.1:${port}`, `http://127.0.0.1:${port + 1}`, 'null']) {
      for (const route of ['/action', '/next', '/new', '/seats/1/action', '/seats/5/action']) {
        const crossSite = await rawRequest(port, { method: 'POST', route, headers: { ...json, Origin: origin }, body });
        assert.equal(crossSite.status, 403, `${origin} ${route}`);
      }
    }
    const untouched = (await get('/state')).body;
    assert.deepEqual([untouched.status, untouched.hand.number, untouched.hand.log], ['your_turn', 1, []], 'a refused write changes nothing');

    const textPlain = await fetch(`${url}/action`, { method: 'POST', body });
    assert.equal(textPlain.status, 415);
    assert.match((await textPlain.json()).error, /application\/json/);
    assert.equal((await rawRequest(port, { method: 'POST', route: '/next' })).status, 415, 'no content type at all');
    assert.equal((await rawRequest(port, { method: 'POST', route: '/action', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'label=fold' })).status, 415);
    assert.equal((await rawRequest(port, { method: 'POST', route: '/action', headers: json, body: '{"label":' })).status, 400);
    assert.equal((await rawRequest(port, { method: 'POST', route: '/action', headers: json, body: JSON.stringify({ label: 'fold', pad: 'x'.repeat(9000) }) })).status, 413);
    // The limit is 8192 bytes: enough for six seats, each with a model name and a 200-character style note.
    const sized = bytes => JSON.stringify({ label: 'check', pad: 'x'.repeat(bytes - JSON.stringify({ label: 'check', pad: '' }).length) });
    assert.deepEqual([Buffer.byteLength(sized(8192)), Buffer.byteLength(sized(8193))], [8192, 8193]);
    const atLimit = await rawRequest(port, { method: 'POST', route: '/action', headers: json, body: sized(8192) });
    assert.deepEqual([atLimit.status, atLimit.body.code], [400, 'ILLEGAL_ACTION'], 'a body at the limit is read, and its label refused on its merits');
    assert.equal((await rawRequest(port, { method: 'POST', route: '/action', headers: json, body: sized(8193) })).status, 413);
    assert.equal((await rawRequest(port, { method: 'POST', route: '/new', headers: json, body: JSON.stringify({ players: ['human', 'rule'], pad: 'x'.repeat(8200) }) })).status, 413);
    const afterBodies = (await get('/state')).body;
    assert.deepEqual([afterBodies.hand.log.length, afterBodies.seed], [0, SEED]);

    assert.equal((await get('/nothing-here')).status, 404);
    assert.equal((await get('/seats/6/view')).status, 404, 'there is no seventh seat');
    assert.equal((await get('/seats/1/cards')).status, 404);
    assert.equal((await rawRequest(port, { method: 'DELETE', route: '/state' })).status, 404);

    // The page's own origin may write.
    const sameOrigin = await rawRequest(port, { method: 'POST', route: '/action', headers: { ...json, Origin: `http://127.0.0.1:${port}` }, body });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.body.hand.number, 1);
  });
});

test('web table: POST /new validates the seats, the models and the turn limit, and keeps the running game on a refusal', async () => {
  await withTable({ hands: 2 }, async ({ get, post, until, built, ended }) => {
    const first = await post('/new', { players: ['human', 'rule'] });
    assert.equal(first.status, 200);
    await until(state => state.status === 'your_turn');
    const before = (await get('/state')).body;
    const builtBefore = built.length;
    const model = name => ({ type: 'model', model: name });
    const refusals = [
      // Two to six seats.
      [{ players: [] }, 400, 'INVALID_INPUT', /2 to 6 seats/],
      [{ players: ['human'] }, 400, 'INVALID_INPUT', /2 to 6 seats/],
      [{ players: ['human', ...Array(6).fill('rule')] }, 400, 'INVALID_INPUT', /2 to 6 seats/],
      [{ players: ['human', ...Array(11).fill('rule')] }, 400, 'INVALID_INPUT', /2 to 6 seats/],
      // Known, available types, as an id or as `{ type, model }`.
      [{ players: ['human', 'wizard'] }, 400, 'INVALID_INPUT', /Unknown player type/],
      [{ players: ['human', { type: 'wizard' }] }, 400, 'INVALID_INPUT', /Unknown player type/],
      [{ players: ['human', {}] }, 400, 'INVALID_INPUT', /Unknown player type/],
      [{ players: ['human', null] }, 400, 'INVALID_INPUT', /Unknown player type/],
      [{ players: ['human', 'offline'] }, 409, 'PLAYER_UNAVAILABLE', /not installed/],
      // A person sits in the bottom seat only.
      [{ players: ['rule', 'human'] }, 400, 'INVALID_INPUT', /bottom seat/],
      [{ players: ['human', 'rule', 'human'] }, 400, 'INVALID_INPUT', /bottom seat/],
      [{ players: ['agent', 'rule', 'rule', 'rule', 'rule', { type: 'human' }] }, 400, 'INVALID_INPUT', /bottom seat/],
      // Only a type that lists models takes one.
      [{ players: ['human', { type: 'rule', model: 'x' }] }, 400, 'INVALID_INPUT', /does not take a model/],
      [{ players: [{ type: 'human', model: 'model-a' }, 'rule'] }, 400, 'INVALID_INPUT', /does not take a model/],
      [{ players: ['human', { type: 'agent', model: 'model-a' }] }, 400, 'INVALID_INPUT', /does not take a model/],
      // The model name reaches a command line: plain identifier characters only, 64 at most.
      [{ players: ['human', model('model a')] }, 400, 'INVALID_INPUT', /model must be/],
      [{ players: ['human', model(' model-a')] }, 400, 'INVALID_INPUT', /model must be/],
      [{ players: ['human', model('m'.repeat(65))] }, 400, 'INVALID_INPUT', /model must be/],
      [{ players: ['human', model('model-a;id')] }, 400, 'INVALID_INPUT', /model must be/],
      [{ players: ['human', model('$(id)')] }, 400, 'INVALID_INPUT', /model must be/],
      [{ players: ['human', model('/a')] }, 400, 'INVALID_INPUT', /model must be/],
      [{ players: ['human', model('a b/c')] }, 400, 'INVALID_INPUT', /model must be/],
      [{ players: ['human', model('model-a\n')] }, 400, 'INVALID_INPUT', /model must be/],
      [{ players: ['human', model(7)] }, 400, 'INVALID_INPUT', /model must be/],
      [{ players: ['human', model(['model-a'])] }, 400, 'INVALID_INPUT', /model must be/],
      [{ players: ['human', 'rule', model('model-a'), model('no good')] }, 400, 'INVALID_INPUT', /model must be/],
      // The turn limit is 0 (none) to ten minutes, in whole milliseconds.
      [{ players: ['human', 'rule'], turn_limit_ms: -1 }, 400, 'INVALID_INPUT', /turn_limit_ms/],
      [{ players: ['human', 'rule'], turn_limit_ms: 600_001 }, 400, 'INVALID_INPUT', /turn_limit_ms/],
      [{ players: ['human', 'rule'], turn_limit_ms: 1e15 }, 400, 'INVALID_INPUT', /turn_limit_ms/],
      [{ players: ['human', 'rule'], turn_limit_ms: 1500.5 }, 400, 'INVALID_INPUT', /turn_limit_ms/],
      [{ players: ['human', 'rule'], turn_limit_ms: '5000' }, 400, 'INVALID_INPUT', /turn_limit_ms/],
      [{ players: ['human', 'rule'], turn_limit_ms: null }, 400, 'INVALID_INPUT', /turn_limit_ms/],
      [{ turn_limit_ms: -5 }, 400, 'INVALID_INPUT', /turn_limit_ms/]
    ];
    for (const [body, status, code, message] of refusals) {
      const refused = await post('/new', body);
      assert.deepEqual([refused.status, refused.body.code], [status, code], JSON.stringify(body).slice(0, 120));
      assert.match(refused.body.error, message, JSON.stringify(body).slice(0, 120));
    }
    const running = (await get('/state')).body;
    assert.deepEqual([running.status, running.seed, running.hand.number], ['your_turn', SEED, 1]);
    assert.deepEqual(running, before, 'a refused game leaves every part of the running one alone, the clock included');
    assert.equal(built.length, builtBefore, 'no player is built for a refused game');

    // No body keeps the same players; each new game takes the next seed.
    const again = await post('/new');
    assert.equal(again.status, 200);
    assert.deepEqual([again.body.seed, again.body.players.map(player => player.type), again.body.settings.turn_limit_ms], [SEED + 1, ['human', 'rule'], 30_000]);

    // Six seats, three with a model. A name shows its model, and equal names are numbered.
    const longest = `Model_1.5:beta-${'x'.repeat(49)}`;
    assert.equal(longest.length, 64);
    const six = await post('/new', { players: ['human', model('model-a'), model('model-a'), 'rule', 'rule', model(longest)], turn_limit_ms: 45_000 });
    assert.equal(six.status, 200, six.text);
    assert.deepEqual(six.body.players.map(({ seat, type, model: chosen, name }) => [seat, type, chosen, name]), [
      [0, 'human', null, 'You'],
      [1, 'model', 'model-a', 'Model · model-a 1'],
      [2, 'model', 'model-a', 'Model · model-a 2'],
      [3, 'rule', null, 'Bot 1'],
      [4, 'rule', null, 'Bot 2'],
      [5, 'model', longest, `Model · ${longest}`]
    ]);
    assert.deepEqual([six.body.seed, six.body.spectator, six.body.settings.turn_limit_ms, six.body.settings.max_seats], [SEED + 2, false, 45_000, 6]);
    assert.deepEqual(six.body.players.map(player => player.think), Array(6).fill(NO_THINKING));
    assert.deepEqual(
      built.slice(-5).map(({ type, seat, model: chosen, seats, seed }) => [type, seat, chosen, seats, seed]),
      [['model', 1, 'model-a', 6, SEED + 2], ['model', 2, 'model-a', 6, SEED + 2], ['rule', 3, null, 6, SEED + 2], ['rule', 4, null, 6, SEED + 2], ['model', 5, longest, 6, SEED + 2]],
      'each built seat is told its model and the size of the table'
    );

    // The human folds; the models and bots play the hand out, and the recap names the model that answered.
    await until(state => state.status === 'your_turn');
    assert.equal((await post('/action', { label: 'fold' })).status, 200);
    const over = await until(state => state.status === 'hand_over');
    assert.deepEqual([over.hand.decisions[5][0].source, over.hand.decisions[5][0].model], ['agent', longest]);
    assert.ok(over.hand.decisions[1].length > 0 && over.hand.decisions[1].every(decision => decision.source === 'forced' || decision.model === 'model-a'));
    assert.ok(over.hand.decisions[3].every(decision => decision.model === null), 'a rule bot names no model');

    // No body again: the same six seats with their models, and the same turn limit.
    const same = await post('/new');
    assert.equal(same.status, 200);
    assert.deepEqual(same.body.players.map(player => [player.type, player.model, player.name]), six.body.players.map(player => [player.type, player.model, player.name]));
    assert.deepEqual([same.body.seed, same.body.settings.turn_limit_ms], [SEED + 3, 45_000]);
    // Only the limit: the seats stay. Zero switches the clock off.
    const unlimited = await post('/new', { turn_limit_ms: 0 });
    assert.deepEqual([unlimited.status, unlimited.body.settings.turn_limit_ms, unlimited.body.players.length], [200, 0, 6]);
    assert.equal((await post('/new', { turn_limit_ms: 600_000 })).body.settings.turn_limit_ms, 600_000, 'ten minutes is the longest limit');

    // Replacing a game ends its match; the log hook is told which model sat where.
    await waitFor(() => ended.some(context => context.seed === SEED + 2), 'the replaced match to end');
    assert.deepEqual(ended.find(context => context.seed === SEED + 2), {
      players: ['human', 'model', 'model', 'rule', 'rule', 'model'],
      seats: [null, 'model-a', 'model-a', null, null, longest].map((chosen, seat) => ({ type: six.body.players[seat].type, model: chosen, reasoning: null, style: null, style_note: null })),
      seed: SEED + 2
    });
  });
});

test('web table: GET /events signals every change with a version number', async () => {
  await withTable({ hands: 2 }, async ({ table, url, until }) => {
    const response = await fetch(`${url}/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const versions = () => [...received.matchAll(/data: (\d+)\n\n/g)].map(match => Number(match[1]));
    const readUntil = async predicate => {
      while (!predicate()) {
        const { value, done } = await withDeadline(reader.read(), 5000, 'an event');
        assert.equal(done, false, 'the stream stays open');
        received += decoder.decode(value, { stream: true });
      }
    };
    try {
      await readUntil(() => versions().length >= 1);
      assert.deepEqual(versions(), [0]);
      await table.newGame({ players: ['human', 'rule'] });
      const turn = await until(state => state.status === 'your_turn');
      await readUntil(() => versions().at(-1) >= turn.version);
      const all = versions();
      assert.ok(all.every((version, index) => index === 0 || version === all[index - 1] + 1), 'versions arrive in order with none skipped');
    } finally {
      await reader.cancel();
    }
  });
});

test('web table: an open seat sees only its own cards, plays by label, and keeps its notes', async () => {
  await withTable({ hands: 1 }, async ({ table, get, post, until, matches }) => {
    await table.newGame({ players: ['human', 'agent'] });
    const start = await until(state => state.status === 'your_turn');
    const humanCards = start.hand.cards[0];
    assert.equal(humanCards.length, 2);
    assert.deepEqual(start.players.map(player => player.name), ['You', 'Open seat']);
    assert.equal(start.spectator, false);

    const notOpen = (await get('/seats/0/view')).body;
    assert.deepEqual([notOpen.status, notOpen.view, notOpen.legal_actions, notOpen.last_result], ['seat_not_open', null, [], null]);
    const humanSeat = await post('/seats/0/action', { label: 'fold' });
    assert.deepEqual([humanSeat.status, humanSeat.body.code], [409, 'SEAT_NOT_OPEN']);

    const waiting = (await get('/seats/1/view')).body;
    assert.deepEqual(
      Object.keys(waiting),
      ['schema_version', 'seat', 'status', 'hand_number', 'view', 'legal_actions', 'situation', 'odds', 'opponent_profiles', 'style', 'last_result', 'deadline', 'timeout_ms'],
      'the v2 seat view has these fields and no others'
    );
    assert.deepEqual([waiting.schema_version, waiting.seat, waiting.status, waiting.hand_number], [SEAT_SCHEMA, 1, 'waiting', 1]);
    assert.deepEqual(
      [waiting.view, waiting.legal_actions, waiting.situation, waiting.odds, waiting.opponent_profiles, waiting.last_result, waiting.deadline, waiting.timeout_ms],
      [null, [], null, null, null, null, null, 30_000]
    );
    const outOfTurn = await post('/seats/1/action', { label: 'call' });
    assert.deepEqual([outOfTurn.status, outOfTurn.body.code], [409, 'NOT_YOUR_TURN']);
    const shortPoll = await get('/seats/1/view?wait=30');
    assert.equal(shortPoll.body.status, 'waiting', 'a long poll gives up after its wait');

    // A long poll is answered as soon as the human's raise puts the open seat on the clock.
    const asked = Date.now();
    const poll = get('/seats/1/view?wait=20000');
    assert.equal((await post('/action', { label: 'raise_small' })).status, 200);
    const turn = await withDeadline(poll, 5000, 'the long poll');
    assert.ok(Date.now() - asked < 5000);
    assert.equal(turn.body.status, 'your_turn');
    const agentCards = turn.body.view.hole_cards;
    assert.equal(agentCards.length, 2);
    assert.deepEqual([turn.body.view.seat, turn.body.view.street, turn.body.view.to_call, turn.body.view.pot], [1, 'preflop', 100, 300]);
    assert.deepEqual([turn.body.view.seats, turn.body.view.players_dealt_in, turn.body.view.players_in_hand, turn.body.view.in_hand, turn.body.view.position], [2, 2, 2, true, 'big blind']);
    assert.deepEqual(turn.body.view.opponents, [{ seat: 0, stack: STACK - 200, committed: 200, in_hand: true, all_in: false, is_button: true }]);
    assert.equal(turn.body.view.opponent_stack, STACK - 200);
    assert.deepEqual(turn.body.legal_actions, turn.body.view.legal_actions);
    assert.deepEqual(turn.body.legal_actions.map(action => action.label), ['fold', 'call', 'raise_small', 'raise_large', 'all_in']);
    assert.ok(turn.body.odds.win_chance > 0 && turn.body.odds.win_chance < 1);
    assert.deepEqual([turn.body.odds.price_to_call, turn.body.odds.opponents_in], [0.25, 1], 'one hundred more chips into a pot of four hundred, against one player');
    assert.equal(typeof turn.body.situation.my_hand_strength, 'string');
    assert.equal(turn.body.situation.opponents_still_in, undefined, 'two players keep the two-player description');
    assert.deepEqual(Object.keys(turn.body.opponent_profiles), ['0']);
    assert.deepEqual(turn.body.opponent_profiles[0], { decisions: 1, raises: 1, faced_raises: 0, folds_to_raise: 0 });
    for (const card of humanCards) assert.ok(!mentionsCard(turn.text, card), `the seat view must not contain ${card}`);

    // The page shows the human's cards and never the open seat's.
    const pageState = await get('/state');
    assert.deepEqual(pageState.body.hand.cards, [humanCards, null]);
    for (const card of agentCards) assert.ok(!mentionsCard(pageState.text, card), `the page state must not contain ${card}`);
    // The seat and the page read the same clock.
    assert.deepEqual([pageState.body.hand.acting, turn.body.deadline, turn.body.timeout_ms], [1, pageState.body.hand.deadline, 30_000]);
    assert.equal(pageState.body.hand.deadline, pageState.body.hand.turn_started_at + 30_000);

    for (const label of ['check', 'bet_250', undefined]) {
      const refused = await post('/seats/1/action', { label, note: 'let me in' });
      assert.deepEqual([refused.status, refused.body.code], [400, 'ILLEGAL_ACTION'], String(label));
    }
    assert.equal((await get('/seats/1/view')).body.status, 'your_turn', 'a refused label leaves the turn open');

    const longNote = `The price is fair. ${'x'.repeat(300)}`;
    const called = await post('/seats/1/action', { label: 'call', note: longNote });
    assert.equal(called.status, 200);
    assert.equal(called.body.schema_version, SEAT_SCHEMA);

    // The hand advanced: the big blind acts first on the flop.
    const flop = await withDeadline(get('/seats/1/view?wait=20000'), 5000, 'the flop');
    assert.deepEqual([flop.body.status, flop.body.view.street, flop.body.view.board.length, flop.body.view.to_call], ['your_turn', 'flop', 3, 0]);
    assert.equal(flop.body.odds.price_to_call, 0);
    assert.equal((await post('/seats/1/action', { label: 'check', note: 42 })).status, 200);
    const humanTurn = await until(state => state.status === 'your_turn');
    assert.deepEqual(humanTurn.hand.log.map(entry => [entry.seat, entry.street, entry.label]), [[0, 'preflop', 'raise_small'], [1, 'preflop', 'call'], [1, 'flop', 'check']]);
    assert.ok(humanTurn.hand.log.every(entry => entry.timed_out === false && Number.isInteger(entry.think_ms) && entry.think_ms >= 0));
    assert.equal(humanTurn.hand.decisions, null, 'choices are shown only after the hand');
    assert.equal((await post('/action', { label: 'raise_small' })).status, 200);
    const facingBet = await withDeadline(get('/seats/1/view?wait=20000'), 5000, 'the bet');
    assert.equal(facingBet.body.status, 'your_turn');
    assert.equal((await post('/seats/1/action', { label: 'fold', note: '  Too expensive.  ' })).status, 200);

    const over = await until(state => state.status === 'hand_over');
    assert.equal(over.hand.decisions[0], null);
    assert.deepEqual(over.hand.decisions[1].map(({ street, label, source, reason, note }) => ({ street, label, source, reason, note })), [
      { street: 'preflop', label: 'call', source: 'agent', reason: null, note: longNote.slice(0, 200) },
      { street: 'flop', label: 'check', source: 'agent', reason: null, note: null },
      { street: 'flop', label: 'fold', source: 'agent', reason: null, note: 'Too expensive.' }
    ]);
    assert.deepEqual([over.hand.result.reason, over.hand.result.winner, over.hand.result.winners, over.hand.result.showdown, over.hand.cards[1]], ['fold', 0, [0], false, null]);

    const afterHand = await get('/seats/1/view');
    assert.deepEqual([afterHand.body.status, afterHand.body.view, afterHand.body.legal_actions, afterHand.body.deadline], ['hand_over', null, [], null]);
    const result = afterHand.body.last_result;
    assert.deepEqual(
      [result.hand_number, result.reason, result.you_won, result.winners, result.shown_cards, result.hand_names],
      [1, 'fold', false, [0], null, null]
    );
    assert.deepEqual([result.your_net, result.pot], [over.hand.result.net[1], over.hand.result.pot]);
    assert.ok(result.your_net < 0);
    for (const card of humanCards) assert.ok(!mentionsCard(afterHand.text, card), 'no showdown, so the human\'s cards stay hidden');

    assert.equal((await post('/next')).status, 200);
    await until(state => state.status === 'match_over');
    // A finished match answers a long poll at once.
    const finished = await withDeadline(get('/seats/1/view?wait=20000'), 5000, 'the match_over view');
    assert.equal(finished.body.status, 'match_over');
    await table.finished();
    assert.equal(matches[0].illegal_actions, 0);
    assert.deepEqual(matches[0].log[0].actions.filter(action => action.seat === 1).map(action => [action.label, action.meta.source, action.meta.note]), [
      ['call', 'agent', longNote.slice(0, 200)],
      ['check', 'agent', null],
      ['fold', 'agent', 'Too expensive.']
    ]);
    assert.deepEqual(matches[0].log[0].hole_cards, [humanCards, agentCards]);
  });
});

test('web table: an open seat that does not answer in time is checked or folded', async () => {
  // The clock runs for every seat, so the other seat is a script that answers at once: it calls
  // before the flop and bets on it. Nobody plays the open seat.
  const LIMIT = 40;
  const createPlayer = () => createScriptedPlayer(['call', 'raise_small'], { name: 'Script' });
  await withTable({ hands: 1, turnLimitMs: LIMIT, createPlayer }, async ({ table, get, post, until, matches }) => {
    const started = await table.newGame({ players: ['rule', 'agent'] });
    assert.equal(started.settings.turn_limit_ms, LIMIT);
    assert.equal((await get('/seats/1/view')).body.timeout_ms, LIMIT);

    // The open seat checks its big blind, checks the flop, then folds to the bet.
    const over = await until(state => state.status === 'hand_over');
    assert.deepEqual(over.hand.log.map(entry => [entry.seat, entry.street, entry.label, entry.timed_out]), [
      [0, 'preflop', 'call', false],
      [1, 'preflop', 'check', true],
      [1, 'flop', 'check', true],
      [0, 'flop', 'raise_small', false],
      [1, 'flop', 'fold', true]
    ]);
    assert.deepEqual(over.hand.log.filter(entry => entry.seat === 1).map(entry => entry.think_ms), [LIMIT, LIMIT, LIMIT], 'a timed-out turn took the whole limit');
    assert.deepEqual(over.hand.decisions[1].map(({ label, source, reason, note, think_ms: thinkMs }) => ({ label, source, reason, note, thinkMs })), [
      { label: 'check', source: 'fallback', reason: 'timeout', note: null, thinkMs: LIMIT },
      { label: 'check', source: 'fallback', reason: 'timeout', note: null, thinkMs: LIMIT },
      { label: 'fold', source: 'fallback', reason: 'timeout', note: null, thinkMs: LIMIT }
    ]);
    assert.deepEqual([over.hand.result.reason, over.hand.result.winner], ['fold', 0]);
    assert.deepEqual(over.warnings, [], 'a timeout is not an error notice');
    assert.deepEqual([over.hand.acting, over.hand.deadline, over.hand.turn_started_at], [null, null, null]);
    assert.deepEqual(over.players[1].think, { count: 3, total_ms: 3 * LIMIT, mean_ms: LIMIT, max_ms: LIMIT, last_ms: LIMIT });

    // The turn the clock played is closed: the seat is told so, and a late answer is refused.
    const seat = (await get('/seats/1/view')).body;
    assert.deepEqual([seat.status, seat.view, seat.legal_actions, seat.deadline], ['hand_over', null, [], null]);
    for (const label of ['call', 'check', 'fold']) {
      const late = await post('/seats/1/action', { label });
      assert.deepEqual([late.status, late.body.code], [409, 'NOT_YOUR_TURN'], label);
    }
    assert.equal((await post('/next')).status, 200);
    await until(state => state.status === 'match_over');
    await table.finished();
    assert.equal(matches[0].illegal_actions, 0);
    assert.deepEqual(matches[0].players[1].decision_sources.by_reason, { timeout: 3 });
    assert.deepEqual([matches[0].decision_timeout_ms, matches[0].players[1].think_ms_total, matches[0].players[0].decision_sources.fallback], [LIMIT, 3 * LIMIT, 0]);
  });
});

// Open: a model seat cut off by the clock is played as a timeout, like any other seat, yet the
// page gets an error notice for it. `timedDecision` in Poker/src/match.mjs plays the turn
// and aborts the signal; the abandoned call then fails with AGENT_CLI_ABORTED, `createModelPlayer`
// turns that into a fallback decision with `meta.error`, and the seat wrapper in
test('web table: a model seat cut off by the turn clock is a timeout, not an error notice', async () => {
  const LIMIT = 30;
  const signals = [];
  // Like the command-line adapter: the call only ends when its signal fires, and then it fails.
  const ask = (prompt, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(Object.assign(new Error('model was stopped because the turn ran out of time'), { code: 'AGENT_CLI_ABORTED' })), { once: true });
  });
  const createPlayer = (type, context) => (type === 'rule'
    ? createScriptedPlayer(['call'], { name: 'Script' })
    : createModelPlayer({ name: 'Model', ask, random: seededRandom(context.seed + 1 + context.seat), iterations: 40 }));
  await withTable({ hands: 1, turnLimitMs: LIMIT, createPlayer }, async ({ table, until }) => {
    await table.newGame({ players: ['rule', 'model'] });
    const over = await until(state => state.status === 'hand_over');
    const modelTurns = over.hand.log.filter(entry => entry.seat === 1);
    assert.ok(modelTurns.length > 0 && modelTurns.every(entry => entry.timed_out && entry.think_ms === LIMIT && ['check', 'fold'].includes(entry.label)));
    assert.deepEqual(over.hand.decisions[1].map(decision => [decision.source, decision.reason, decision.error]), modelTurns.map(() => ['fallback', 'timeout', null]));
    assert.deepEqual([signals.length, signals.every(signal => signal.aborted)], [modelTurns.length, true], 'every abandoned call was told to stop');
    // Let the abandoned calls finish failing before looking at the notices.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(table.snapshot().warnings, [], 'a timeout is not an error notice');
  });
});

for (const seats of [2, 5]) {
  test(`web table: ${seats} bots play a spectator game that only needs POST /next`, async () => {
    await withTable({ hands: 4 }, async context => {
      const { table, post, matches } = context;
      const live = [];
      const unsubscribe = table.subscribe(() => live.push(table.snapshot()));
      const started = await post('/new', { players: Array(seats).fill('rule') });
      assert.equal(started.status, 200);
      assert.equal(started.body.spectator, true);
      assert.deepEqual(
        started.body.players.map(({ seat, type, name }) => [seat, type, name]),
        Array.from({ length: seats }, (_, seat) => [seat, 'rule', `Bot ${seat + 1}`]),
        'bots get numbered names'
      );

      const hands = [];
      const final = await playOut(context, {
        choose: () => assert.fail('nobody acts for a seat in a spectator game'),
        onReply: ({ body }) => {
          assert.equal(body.spectator, true);
          if (body.status === 'hand_over') hands.push(body.hand);
        }
      });
      unsubscribe();
      await table.finished();

      const [match] = matches;
      assert.equal(final.status, 'match_over');
      assert.ok(match.hands_played >= 1);
      assert.deepEqual([final.match.hands_played, hands.length], [match.hands_played, match.hands_played]);
      assert.equal(sum(final.match.net), 0);
      assert.equal(match.illegal_actions, 0);
      assert.deepEqual(match.players.map(player => player.name), started.body.players.map(player => player.name));
      for (const hand of hands) {
        assert.deepEqual(hand.cards, match.log[hand.number - 1].hole_cards, `hand ${hand.number}: every hand is face up over HTTP, folded or not`);
        // At a larger table a seat can sit a hand out without a decision: the big blind everyone folds to.
        assert.ok(hand.decisions.every(recap => (seats > 2 || recap.length > 0) && recap.every(decision => decision.source === 'rule')));
      }
      if (seats > 2) assert.ok(hands.some(hand => hand.folded.some(Boolean) && hand.result.showdown), 'a folded hand stayed face up through a showdown');
      // The hands are face up while a hand is still being played, not only once it is over.
      const inPlay = live.filter(state => state.hand && !state.hand.result);
      assert.ok(inPlay.length > 0);
      for (const state of inPlay) assert.deepEqual(state.hand.cards, match.log[state.hand.number - 1].hole_cards);

      const noHuman = await post('/action', { label: 'check' });
      assert.deepEqual([noHuman.status, noHuman.body.code], [409, 'NOT_YOUR_TURN']);
    });
  });
}

test('web table: a model seat that fails is played by the rule bot and named in a notice', async () => {
  const asked = [];
  const createPlayer = (type, context) => {
    const random = seededRandom(context.seed + 1 + context.seat);
    if (type === 'rule') return createRulePlayer({ name: 'Bot', random, iterations: 60 });
    return createModelPlayer({
      name: 'Model',
      ask: async prompt => {
        asked.push(prompt);
        throw Object.assign(new Error('Failed to authenticate'), { code: 'AGENT_CLI_ERROR' });
      },
      random,
      iterations: 60
    });
  };
  await withTable({ hands: 2, createPlayer }, async context => {
    const { table, matches } = context;
    await table.newGame({ players: ['rule', 'model'] });
    const hands = [];
    const final = await playOut(context, { onReply: ({ body }) => body.status === 'hand_over' && hands.push(body) });
    await table.finished();
    assert.ok(asked.length > 0);
    assert.deepEqual(final.warnings, ['Model: Failed to authenticate'], 'one notice, not one per decision');
    assert.deepEqual(hands[0].warnings, ['Model: Failed to authenticate']);
    const recap = hands.flatMap(state => state.hand.decisions[1]).filter(decision => decision.source !== 'forced');
    assert.ok(recap.length > 0 && recap.every(decision => decision.source === 'fallback' && decision.reason === 'error' && decision.error === 'Failed to authenticate'));
    assert.equal(matches[0].illegal_actions, 0);
    // The brief holds the model seat's own cards and never the other seat's.
    const [ruleCards, modelCards] = matches[0].log[0].hole_cards;
    assert.match(asked[0], new RegExp(`Your cards: ${modelCards.join(' ')}`));
    for (const card of ruleCards) assert.ok(!mentionsCard(asked[0], card));
  });
});

for (const seats of [4, 6]) {
  test(`web table: at ${seats} seats no snapshot shows a hidden or folded hand, and the chips always add up`, async () => {
    await withTable({ hands: 6 }, async context => {
      const { table, post, matches } = context;
      const total = seats * STACK;
      // Every version the page could have fetched, plus every reply it was sent.
      const seen = [];
      const unsubscribe = table.subscribe(() => seen.push(JSON.stringify(table.snapshot())));
      const started = await post('/new', { players: ['human', ...Array(seats - 1).fill('rule')] });
      assert.equal(started.status, 200, started.text);
      assert.deepEqual(started.body.players.map(player => [player.seat, player.type, player.name]), [
        [0, 'human', 'You'],
        ...Array.from({ length: seats - 1 }, (_, index) => [index + 1, 'rule', `Bot ${index + 1}`])
      ]);
      const final = await playOut(context, { onReply: ({ text }) => seen.push(text) });
      unsubscribe();
      await table.finished();

      const [match] = matches;
      assert.deepEqual([match.seats, match.illegal_actions, match.hands_played], [seats, 0, final.match.hands_played]);
      const covered = { hidden: 0, showdowns: 0, foldedAtShowdown: 0 };
      const buttons = new Set();
      const blindsSeen = new Set();
      for (const text of seen) {
        const { hand, status } = JSON.parse(text);
        if (!hand) continue;
        const record = match.log[hand.number - 1];
        const where = `hand ${hand.number} (${status}, ${hand.log.length} actions)`;
        for (const field of ['dealt_in', 'folded', 'all_in', 'cards', 'hand_names', 'stacks', 'bets']) {
          assert.ok(Array.isArray(hand[field]) && hand[field].length === seats, `${where}: ${field} has one entry per seat`);
        }
        assert.deepEqual(hand.dealt_in, record.hole_cards.map(Boolean), where);
        assert.deepEqual(hand.folded, hand.folded.map((_, seat) => hand.log.some(entry => entry.seat === seat && entry.label === 'fold')), `${where}: folded seats are the seats that folded`);

        // The blinds sit left of the button, which moves one seat with chips each hand.
        assert.equal(hand.button_seat, record.button, where);
        buttons.add(hand.button_seat);
        const headsUp = hand.dealt_in.filter(Boolean).length === 2;
        const smallBlind = headsUp ? hand.button_seat : nextDealtIn(hand.dealt_in, hand.button_seat);
        const bigBlind = nextDealtIn(hand.dealt_in, smallBlind);
        assert.deepEqual([hand.small_blind_seat, hand.big_blind_seat], [smallBlind, bigBlind], where);
        if (!hand.log.length && !hand.result) {
          assert.deepEqual([hand.bets[smallBlind], hand.bets[bigBlind]], [Math.min(50, record.starting_stacks[smallBlind]), Math.min(100, record.starting_stacks[bigBlind])], `${where}: the blinds are posted`);
          assert.deepEqual(hand.stacks.map((chips, seat) => chips + hand.bets[seat]), record.starting_stacks, where);
          blindsSeen.add(hand.number);
        }

        // No chip appears or disappears, whatever the page fetches.
        const chips = sum(hand.stacks) + (hand.result ? 0 : hand.pot);
        assert.equal(chips, total, `${where}: the stacks${hand.result ? '' : ' and the pot'} hold every chip at the table`);

        // The human sees their own cards; another seat's only at a showdown, and never a folded seat's.
        assert.deepEqual(hand.cards[0], record.hole_cards[0], `${where}: the human always sees their own cards`);
        const showdown = Boolean(hand.result?.showdown);
        for (let seat = 1; seat < seats; seat += 1) {
          const theirs = record.hole_cards[seat];
          if (showdown && theirs && !hand.folded[seat]) {
            assert.deepEqual(hand.cards[seat], theirs, `${where}: the showdown turns seat ${seat}'s cards over`);
            assert.equal(hand.hand_names[seat], record.result.hand_names[seat], where);
            continue;
          }
          assert.equal(hand.cards[seat], null, `${where}: seat ${seat}'s cards stay hidden`);
          assert.equal(hand.hand_names[seat], null, `${where}: seat ${seat}'s hand is not named`);
          for (const card of theirs ?? []) assert.ok(!mentionsCard(text, card), `${where}: the state must not contain ${card} of seat ${seat}`);
        }
        if (showdown) {
          covered.showdowns += 1;
          if (hand.folded.slice(1).some(Boolean)) covered.foldedAtShowdown += 1;
        } else {
          covered.hidden += 1;
        }

        if (hand.result) {
          assert.deepEqual([hand.result.net.length, sum(hand.result.net)], [seats, 0], where);
          assert.equal(sum(hand.result.pots.map(pot => pot.amount)), hand.result.pot, where);
          assert.ok(hand.result.winners.length > 0 && hand.result.winners.every(seat => !hand.folded[seat]), `${where}: a folded seat never wins`);
          assert.deepEqual(hand.result.net, record.result.net, where);
        }
      }
      assert.ok(covered.hidden > 0 && covered.showdowns > 0, 'the match covered hidden states and at least one showdown');
      assert.ok(covered.foldedAtShowdown > 0, 'at least one showdown had a folded seat whose cards had to stay down');
      assert.equal(blindsSeen.size, match.hands_played, 'every hand was seen with only its blinds posted');
      assert.ok(buttons.size > 1, 'the button moved');

      assert.equal(final.status, 'match_over');
      assert.deepEqual(final.match.final_stacks, match.final_stacks);
      assert.equal(sum(final.match.final_stacks), total, 'the final stacks hold every chip');
      assert.deepEqual(final.match.net, final.match.final_stacks.map(chips => chips - STACK));
      assert.deepEqual(final.totals.net, final.match.net);
      const most = Math.max(...final.match.final_stacks);
      const leaders = final.match.final_stacks.flatMap((chips, seat) => (chips === most ? [seat] : []));
      assert.equal(final.match.winner_seat, leaders.length === 1 ? leaders[0] : null);
    });
  });
}

// The engine returns the unmatched part of a bet when the action that closes the betting is
// applied, and the hand then goes straight to a showdown. The snapshot for that action must show
// the refund in the bettor's stack, not only in the smaller pot: the page holds it on screen for
// the length of the bot pause.
test('web table: a snapshot holds every chip when an unmatched bet goes back to the bettor', async () => {
  const has = (view, label) => view.legal_actions.some(action => action.label === label);
  const safe = view => (has(view, 'check') ? 'check' : 'fold');
  // Hand 1 makes the stacks 10,400 / 9,950 / 9,650 without a showdown. In hand 2 seat 1 goes
  // all-in for 9,950, seat 2 calls with its 9,650 and seat 0 folds: 300 chips go back to seat 1.
  const script = view => {
    const { seat, street, hand_number: number } = view;
    if (number === 1) {
      if (seat === 0 && street === 'preflop') return 'raise_large';
      if (seat === 2 && street === 'preflop') return 'call';
      return seat === 0 && has(view, 'raise_small') ? 'raise_small' : safe(view);
    }
    if (seat === 1 && has(view, 'all_in')) return 'all_in';
    return seat === 2 && has(view, 'call') ? 'call' : safe(view);
  };
  const createPlayer = () => ({ name: 'Script', kind: 'scripted', decide: async view => ({ label: script(view), meta: { source: 'script' } }) });
  await withTable({ hands: 2, createPlayer }, async context => {
    const { table, matches } = context;
    const live = [];
    const unsubscribe = table.subscribe(() => live.push(table.snapshot()));
    await table.newGame({ players: ['rule', 'rule', 'rule'] });
    await playOut(context);
    unsubscribe();
    await table.finished();
    const [first, second] = matches[0].log;
    assert.deepEqual([first.result.reason, second.starting_stacks], ['fold', [10_400, 9_950, 9_650]]);
    assert.deepEqual(second.actions.map(action => [action.seat, action.label, action.to]), [[1, 'all_in', 9_950], [2, 'call', 9_650], [0, 'fold', 100]]);
    assert.equal(second.result.pot, 9_650 + 9_650 + 100, 'the engine returned the unmatched 300');
    for (const { hand, status } of live) {
      if (!hand) continue;
      const where = `hand ${hand.number} (${status}, ${hand.log.length} actions)`;
      assert.equal(sum(hand.stacks) + (hand.result ? 0 : hand.pot), 3 * STACK, `${where}: the stacks and the pot hold every chip`);
      if (!hand.result) assert.deepEqual(hand.all_in, hand.stacks.map((chips, seat) => hand.dealt_in[seat] && !hand.folded[seat] && chips === 0), `${where}: a seat with chips behind is not all-in`);
    }
    // Before the fold: both bets are out. With the fold: the 300 are back in seat 1's stack, and its bet is what was matched.
    const chipsAfter = actions => {
      const { hand } = live.find(state => state.hand?.number === 2 && state.hand.log.length === actions && !state.hand.result);
      return { pot: hand.pot, stacks: hand.stacks, bets: hand.bets, folded: hand.folded, all_in: hand.all_in };
    };
    assert.deepEqual(chipsAfter(2), { pot: 19_700, stacks: [10_300, 0, 0], bets: [100, 9_950, 9_650], folded: [false, false, false], all_in: [false, true, true] });
    assert.deepEqual(chipsAfter(3), { pot: 19_400, stacks: [10_300, 300, 0], bets: [100, 9_650, 9_650], folded: [true, false, false], all_in: [false, false, true] });
    const over = live.find(state => state.hand?.number === 2 && state.hand.result).hand;
    assert.deepEqual([over.result.showdown, over.result.pot, over.bets, sum(over.stacks)], [true, 19_400, [0, 0, 0], 3 * STACK]);
    assert.deepEqual(over.stacks, matches[0].final_stacks);
  });
});

test('web table: the snapshot for a hand-ending fold keeps the pot on the table until the result', async () => {
  // Heads-up: the button raises and the big blind folds. The fold's own snapshot still shows the
  // chips in the pot; the result then moves them to the winner.
  const createPlayer = (type, context) => createScriptedPlayer(context.seat === 0 ? ['raise_small'] : ['fold'], { name: 'Script' });
  await withTable({ hands: 1, createPlayer }, async context => {
    const { table } = context;
    const live = [];
    const unsubscribe = table.subscribe(() => live.push(table.snapshot()));
    await table.newGame({ players: ['rule', 'rule'] });
    await playOut(context);
    unsubscribe();
    const folded = live.find(state => state.hand?.log.length === 2 && !state.hand.result).hand;
    assert.deepEqual(folded.log.map(entry => [entry.seat, entry.label, entry.to]), [[0, 'raise_small', 200], [1, 'fold', 100]]);
    assert.deepEqual([folded.pot, folded.stacks, folded.bets, folded.folded, folded.all_in], [300, [STACK - 200, STACK - 100], [200, 100], [false, true], [false, false]]);
    const over = live.find(state => state.hand?.result).hand;
    assert.deepEqual([over.result.reason, over.result.winner, over.stacks, over.bets, over.result.net], ['fold', 0, [STACK + 100, STACK - 100], [0, 0], [100, -100]]);
  });
});

test('web table: a seat with no chips left is dealt no cards, and the button and the blinds pass over it', async () => {
  // Seats 0 and 1 go all-in on the first hand and seat 2 folds. After that everyone checks or folds.
  const has = (view, label) => view.legal_actions.some(action => action.label === label);
  const script = view => {
    if (view.hand_number === 1 && view.seat !== 2) return has(view, 'all_in') ? 'all_in' : 'call';
    return has(view, 'check') ? 'check' : 'fold';
  };
  const createPlayer = () => ({ name: 'Script', kind: 'scripted', decide: async view => ({ label: script(view), meta: { source: 'script' } }) });
  await withTable({ hands: 4, createPlayer }, async context => {
    const { table, matches } = context;
    const live = [];
    const unsubscribe = table.subscribe(() => live.push(table.snapshot()));
    await table.newGame({ players: ['rule', 'rule', 'rule'] });
    const final = await playOut(context);
    unsubscribe();
    await table.finished();
    const [match] = matches;
    const [first] = match.log;
    assert.deepEqual([first.result.reason, first.result.pot], ['showdown', 2 * STACK + 100]);
    const out = first.result.net.indexOf(-STACK);
    assert.ok(out === 0 || out === 1, 'one of the two all-in players lost every chip');
    assert.deepEqual([match.hands_played, match.stop_reason, final.match.final_stacks[out]], [4, 'hands_complete', 0]);

    const later = live.filter(state => state.hand && state.hand.number > 1);
    assert.ok(later.length > 0);
    for (const { hand, status } of later) {
      const where = `hand ${hand.number} (${status})`;
      const record = match.log[hand.number - 1];
      assert.deepEqual(hand.dealt_in, [0, 1, 2].map(seat => seat !== out), where);
      assert.deepEqual([hand.cards[out], hand.hand_names[out], hand.stacks[out], hand.bets[out], hand.folded[out], hand.all_in[out]], [null, null, 0, 0, false, false], `${where}: the seat sits out`);
      assert.deepEqual(hand.cards, record.hole_cards, `${where}: the two hands in play are face up, since nobody here is a person`);
      // Two players are left, so the button posts the small blind; it never stops at the empty seat.
      assert.notEqual(hand.button_seat, out, where);
      assert.deepEqual([hand.button_seat, hand.small_blind_seat, hand.big_blind_seat], [record.button, record.button, nextDealtIn(hand.dealt_in, record.button)], where);
      assert.ok(hand.log.every(entry => entry.seat !== out), `${where}: no action is asked of the seat`);
      assert.equal(sum(hand.stacks) + (hand.result ? 0 : hand.pot), 3 * STACK, where);
    }
    assert.deepEqual([...new Set(later.map(state => state.hand.button_seat))].sort(), [0, 1, 2].filter(seat => seat !== out), 'the button alternates between the two players left');
    assert.equal(final.match.winner_seat, final.match.final_stacks.indexOf(Math.max(...final.match.final_stacks)));
  });
});

test('turn clock: a human who does not act is folded or checked, and the late click is refused', async () => {
  const LIMIT = 120;
  await withTable({ hands: 2, turnLimitMs: LIMIT }, async ({ table, get, post, until, matches }) => {
    // The instant a timed-out action of the human is shown, click for them in-process, before the
    // table can do anything else. The label is one that was legal in the turn the clock closed.
    const lateClicks = [];
    const clicked = new Set();
    const history = [];
    const unsubscribe = table.subscribe(() => {
      const state = table.snapshot();
      history.push(state);
      const last = state.hand?.log.at(-1);
      const turn = `${state.hand?.number}:${state.hand?.log.length}`;
      if (!last || last.seat !== 0 || !last.timed_out || clicked.has(turn)) return;
      clicked.add(turn);
      try {
        table.act(last.label === 'fold' ? 'call' : 'check');
        lateClicks.push('accepted');
      } catch (error) {
        lateClicks.push(error.code);
      }
    });

    // Hand 1: the human is first to act and faces the big blind. Nobody plays any seat.
    const humanFolded = until(state => Boolean(state.hand?.log.length));
    const started = await post('/new', { players: ['human', 'agent', 'agent'] });
    assert.deepEqual([started.status, started.body.settings.turn_limit_ms], [200, LIMIT]);
    const afterFold = await humanFolded;
    assert.deepEqual(afterFold.hand.log, [{ seat: 0, street: 'preflop', label: 'fold', amount: 0, to: 0, think_ms: LIMIT, timed_out: true }]);
    assert.deepEqual([afterFold.hand.folded[0], afterFold.hand.legal_actions], [true, []]);
    assert.deepEqual([afterFold.hand.acting, afterFold.hand.turn_started_at, afterFold.hand.deadline], [null, null, null], 'nobody is on the clock between turns');
    assert.deepEqual(lateClicks, ['NOT_YOUR_TURN'], 'the turn the clock played is closed at once');
    // The same over HTTP, while the hand goes on without the human.
    const lateFold = await post('/action', { label: 'call' });
    assert.deepEqual([lateFold.status, lateFold.body.code], [409, 'NOT_YOUR_TURN']);
    const afterLate = (await get('/state')).body;
    assert.deepEqual(afterLate.hand.log.filter(entry => entry.seat === 0), afterFold.hand.log, 'the refused click changed nothing');
    assert.notEqual(afterLate.status, 'your_turn');

    // While the human was on the clock the page could count down to the deadline.
    const humanTurn = history.find(state => state.status === 'your_turn');
    assert.deepEqual([humanTurn.hand.acting, humanTurn.hand.deadline - humanTurn.hand.turn_started_at], [0, LIMIT]);
    assert.deepEqual(humanTurn.hand.legal_actions.map(action => action.label), ['fold', 'call', 'raise_small', 'raise_large', 'all_in']);

    // An open seat times out the same way: the small blind is folded, and the hand is over.
    const first = await until(state => state.status === 'hand_over');
    assert.deepEqual(first.hand.log.map(entry => [entry.seat, entry.label, entry.think_ms, entry.timed_out]), [[0, 'fold', LIMIT, true], [1, 'fold', LIMIT, true]]);
    assert.deepEqual([first.hand.result.reason, first.hand.result.winner, first.hand.decisions[0]], ['fold', 2, null]);
    assert.deepEqual(first.hand.decisions[1].map(({ label, source, reason, think_ms: thinkMs }) => [label, source, reason, thinkMs]), [['fold', 'fallback', 'timeout', LIMIT]]);
    assert.deepEqual(first.warnings, [], 'a timeout is not an error notice');
    assert.equal((await get('/seats/1/view')).body.status, 'hand_over');
    const lateSeat = await post('/seats/1/action', { label: 'call' });
    assert.deepEqual([lateSeat.status, lateSeat.body.code], [409, 'NOT_YOUR_TURN']);

    // Hand 2: the human is the big blind. Both open seats call at once, in-process, so only the
    // human runs out of time: with nothing to call, the clock checks.
    const humanChecked = until(state => state.hand.number === 2 && state.hand.log.some(entry => entry.seat === 0));
    table.next();
    const opener = await seatTurn(table, 1);
    const opening = table.snapshot().hand;
    assert.deepEqual([opening.acting, opener.timeout_ms, opener.deadline, opening.deadline - opening.turn_started_at], [1, LIMIT, opening.deadline, LIMIT]);
    table.seatAct(1, 'call');
    await seatTurn(table, 2);
    table.seatAct(2, 'call');
    const checked = await humanChecked;
    assert.deepEqual(checked.hand.log.at(-1), { seat: 0, street: 'preflop', label: 'check', amount: 0, to: 100, think_ms: LIMIT, timed_out: true });
    assert.deepEqual(checked.hand.log.slice(0, 2).map(entry => [entry.seat, entry.label, entry.timed_out]), [[1, 'call', false], [2, 'call', false]]);
    assert.equal(checked.hand.folded[0], false, 'a check keeps the human in the hand');
    // Seat 2 bets the flop: now the clock folds the human. Seat 1 folds too and the hand ends.
    await seatTurn(table, 2);
    table.seatAct(2, 'raise_small');
    await seatTurn(table, 1);
    table.seatAct(1, 'fold');
    const second = await until(state => state.status === 'hand_over' && state.hand.number === 2);
    assert.deepEqual(second.hand.log.map(entry => [entry.seat, entry.street, entry.label, entry.timed_out]), [
      [1, 'preflop', 'call', false],
      [2, 'preflop', 'call', false],
      [0, 'preflop', 'check', true],
      [2, 'flop', 'raise_small', false],
      [0, 'flop', 'fold', true],
      [1, 'flop', 'fold', false]
    ]);
    assert.ok(second.hand.log.every(entry => (entry.timed_out ? entry.think_ms === LIMIT : entry.think_ms < LIMIT)));
    assert.deepEqual(lateClicks, ['NOT_YOUR_TURN', 'NOT_YOUR_TURN', 'NOT_YOUR_TURN'], 'one refused click after each of the human\'s three timed-out turns');
    assert.deepEqual(second.players[0].think, { count: 3, total_ms: 3 * LIMIT, mean_ms: LIMIT, max_ms: LIMIT, last_ms: LIMIT });
    assert.deepEqual(second.warnings, []);

    unsubscribe();
    assert.equal((await post('/next')).status, 200);
    await until(state => state.status === 'match_over');
    await table.finished();
    const [match] = matches;
    assert.deepEqual([match.illegal_actions, match.hands_played, match.decision_timeout_ms], [0, 2, LIMIT]);
    assert.deepEqual(match.players.map(player => player.decision_sources.by_reason), [{ timeout: 3 }, { timeout: 1 }, {}]);
    assert.deepEqual(match.log[0].actions.map(action => action.meta), [{ source: 'fallback', reason: 'timeout' }, { source: 'fallback', reason: 'timeout' }]);
  });
});

test('turn clock: the deadline is the turn start plus the limit, and without a limit nothing is played for anyone', async () => {
  await withTable({ hands: 1, turnLimitMs: 0 }, async ({ table, get, post, until }) => {
    assert.equal((await get('/state')).body.settings.turn_limit_ms, 0);
    const before = Date.now();
    assert.equal((await post('/new', { players: ['human', 'agent'] })).status, 200);
    const free = await until(state => state.status === 'your_turn');
    assert.deepEqual([free.settings.turn_limit_ms, free.hand.acting, free.hand.deadline], [0, 0, null]);
    assert.ok(free.hand.turn_started_at >= before && free.hand.turn_started_at <= Date.now(), 'the stopwatch still runs');
    assert.equal((await post('/action', { label: 'raise_small' })).status, 200);
    const seat = await withDeadline(get('/seats/1/view?wait=20000'), 5000, 'the open seat\'s turn');
    assert.deepEqual([seat.body.status, seat.body.deadline, seat.body.timeout_ms], ['your_turn', null, null]);
    // The open seat takes its time. Nothing is played for it, and the time it took is recorded.
    const PONDER = 60;
    await new Promise(resolve => setTimeout(resolve, PONDER));
    const still = (await get('/state')).body;
    assert.deepEqual([still.hand.acting, still.hand.deadline, still.hand.log.length, (await get('/seats/1/view')).body.status], [1, null, 1, 'your_turn']);
    assert.equal((await post('/seats/1/action', { label: 'fold' })).status, 200);
    const over = await until(state => state.status === 'hand_over');
    const [raise, fold] = over.hand.log;
    assert.deepEqual([raise.timed_out, fold.timed_out, fold.label], [false, false, 'fold']);
    assert.ok(fold.think_ms >= PONDER - 10, `the open seat's ${fold.think_ms} ms of thinking were measured`);
    assert.deepEqual([over.players[1].think.count, over.players[1].think.last_ms, over.hand.decisions[1][0].think_ms], [1, fold.think_ms, fold.think_ms]);

    // The same seats with a limit, chosen over HTTP.
    const limited = await post('/new', { turn_limit_ms: 30_000 });
    assert.deepEqual([limited.status, limited.body.settings.turn_limit_ms, limited.body.players.map(player => player.type)], [200, 30_000, ['human', 'agent']]);
    const timed = await until(state => state.status === 'your_turn');
    assert.deepEqual([timed.hand.acting, timed.hand.deadline], [0, timed.hand.turn_started_at + 30_000]);
    assert.equal((await post('/action', { label: 'call' })).status, 200);
    const clocked = await withDeadline(get('/seats/1/view?wait=20000'), 5000, 'the open seat\'s turn');
    const page = (await get('/state')).body;
    assert.deepEqual([clocked.body.status, clocked.body.timeout_ms, clocked.body.deadline], ['your_turn', 30_000, page.hand.deadline]);
    assert.deepEqual([page.hand.acting, page.hand.deadline], [1, page.hand.turn_started_at + 30_000]);
    assert.ok(page.hand.turn_started_at >= timed.hand.turn_started_at, 'each turn starts its own clock');
    // Once the seat has answered, nobody is on the clock until the next turn is announced.
    const answered = table.seatAct(1, 'check');
    assert.deepEqual([answered.status, answered.deadline], ['waiting', null]);
  });
});

test('web table: every action records its reasoning time, added up per seat and in the match result', async () => {
  await withTable({ hands: 3 }, async context => {
    const { post, matches, table } = context;
    const players = ['human', 'rule', { type: 'model', model: 'model-b' }, 'rule'];
    const started = await post('/new', { players });
    assert.equal(started.status, 200, started.text);
    assert.deepEqual(started.body.players.map(player => player.think), Array(4).fill(NO_THINKING));
    const times = players.map(() => []);
    const hands = [];
    const final = await playOut(context, {
      onReply: ({ body }) => {
        if (body.status !== 'hand_over' || hands.some(hand => hand.number === body.hand.number)) return;
        const { hand } = body;
        hands.push(hand);
        assert.ok(hand.log.length > 0);
        for (const entry of hand.log) {
          assert.ok(Number.isInteger(entry.think_ms) && entry.think_ms >= 0, `hand ${hand.number}: think_ms is a whole number of milliseconds, not ${entry.think_ms}`);
          assert.equal(entry.timed_out, false);
          times[entry.seat].push(entry.think_ms);
        }
        // The running totals cover every hand so far, not only this one.
        assert.deepEqual(body.players.map(player => player.think), times.map(thinkingOf), `hand ${hand.number}`);
        assert.equal(hand.decisions[0], null);
        for (let seat = 1; seat < players.length; seat += 1) {
          assert.deepEqual(
            hand.decisions[seat].map(decision => [decision.street, decision.label, decision.think_ms]),
            hand.log.filter(entry => entry.seat === seat).map(entry => [entry.street, entry.label, entry.think_ms]),
            `hand ${hand.number}: seat ${seat}'s choices carry the time each one took`
          );
        }
        assert.ok(hand.decisions[2].every(decision => decision.source === 'forced' || (decision.source === 'agent' && decision.model === 'model-b')), 'the recap names the model that answered');
      }
    });
    await table.finished();
    const [match] = matches;
    assert.equal(hands.length, match.hands_played);
    assert.ok(times.every(seatTimes => seatTimes.length > 0), 'every seat made a decision');
    assert.deepEqual(final.players.map(player => player.think), times.map(thinkingOf));
    assert.deepEqual(
      match.players.map(player => [player.think_ms_total, player.think_ms_mean, player.think_ms_max]),
      times.map(thinkingOf).map(think => [think.total_ms, think.mean_ms, think.max_ms]),
      'the match result carries the same totals'
    );
    for (const hand of hands) {
      assert.deepEqual(match.log[hand.number - 1].actions.map(action => [action.seat, action.label, action.think_ms]), hand.log.map(entry => [entry.seat, entry.label, entry.think_ms]));
    }
  });
});

test('web table: the pause that keeps a bot\'s action on screen is not reasoning time', async () => {
  const PAUSE = 80;
  await withTable({ hands: 1, botDelayMs: PAUSE }, async ({ table, post, until, matches }) => {
    const shownAt = [];
    const unsubscribe = table.subscribe(() => {
      if ((table.snapshot().hand?.log.length ?? 0) > shownAt.length) shownAt.push(performance.now());
    });
    assert.equal((await post('/new', { players: ['rule', 'rule'] })).status, 200);
    const over = await until(state => state.status === 'hand_over');
    const ended = performance.now();
    unsubscribe();
    assert.ok(over.hand.log.length > 0);
    assert.equal(shownAt.length, over.hand.log.length);
    // Each action is shown first and then held: the next one, or the end of the hand, comes a pause later.
    const held = shownAt.map((time, index) => (shownAt[index + 1] ?? ended) - time);
    assert.ok(held.every(gap => gap >= PAUSE - 10), `every action was held on screen: ${held.map(Math.round).join(', ')} ms`);
    // A rule bot answers in a few milliseconds. With the pause counted, every figure would be 80 or more.
    for (const entry of over.hand.log) assert.ok(entry.think_ms < PAUSE / 2, `${entry.label} took ${entry.think_ms} ms of reasoning`);
    for (const player of over.players) {
      if (player.think.count) assert.ok(player.think.max_ms < PAUSE / 2 && player.think.total_ms < player.think.count * (PAUSE / 2), JSON.stringify(player.think));
    }
    assert.ok(over.hand.decisions.flat().every(decision => decision.think_ms < PAUSE / 2));
    assert.equal((await post('/next')).status, 200);
    await until(state => state.status === 'match_over');
    await table.finished();
    for (const player of matches[0].players) assert.ok((player.think_ms_max ?? 0) < PAUSE / 2 && player.think_ms_total < over.hand.log.length * (PAUSE / 2), JSON.stringify(player));
  });
});

test('web table: the match winner is the seat with the most chips, and nobody on a tie', async () => {
  // Every seat only checks or folds, so each hand the big blind collects the small blind's 50 chips.
  const createPlayer = () => createScriptedPlayer([], { name: 'Folder' });
  const cases = [
    { seats: 2, hands: 1, stacks: [9_950, 10_050], winner: 1 },
    { seats: 2, hands: 2, stacks: [10_000, 10_000], winner: null },
    { seats: 3, hands: 1, stacks: [10_000, 9_950, 10_050], winner: 2 },
    { seats: 3, hands: 2, stacks: [10_050, 9_950, 10_000], winner: 0 },
    { seats: 3, hands: 3, stacks: [10_000, 10_000, 10_000], winner: null },
    { seats: 4, hands: 2, stacks: [10_000, 9_950, 10_000, 10_050], winner: 3 }
  ];
  for (const { seats, hands, stacks, winner } of cases) {
    await withTable({ hands, createPlayer }, async context => {
      const started = await context.table.newGame({ players: Array(seats).fill('rule') });
      assert.equal(started.match, null);
      const final = await playOut(context);
      const what = `${seats} seats, ${hands} hands`;
      assert.deepEqual([final.match.stop_reason, final.match.hands_played, final.match.final_stacks], ['hands_complete', hands, stacks], what);
      assert.equal(final.match.winner_seat, winner, `${what}: ${winner === null ? 'a tie for the most chips marks nobody' : `seat ${winner} has the most chips`}`);
      assert.deepEqual(final.match.net, stacks.map(chips => chips - STACK), what);
    });
  }
});

test('seat protocol v2: seats 0 to 5 have a route, and only a seat that is open answers with a view', async () => {
  await withTable({ hands: 1 }, async ({ table, get, post, until }) => {
    const idle = await get('/seats/5/view');
    assert.deepEqual([idle.status, idle.body.schema_version, idle.body.seat, idle.body.status], [200, SEAT_SCHEMA, 5, 'idle']);
    const tooEarly = await post('/seats/5/action', { label: 'fold' });
    assert.deepEqual([tooEarly.status, tooEarly.body.code], [409, 'SEAT_NOT_OPEN']);

    // Three seats: a person, an open seat and a bot. Seats 3 to 5 are empty chairs.
    await table.newGame({ players: ['human', 'agent', 'rule'] });
    await until(state => state.status === 'your_turn');
    for (const seat of [0, 2, 3, 4, 5]) {
      const view = await get(`/seats/${seat}/view`);
      assert.deepEqual(
        [view.status, view.body.schema_version, view.body.seat, view.body.status, view.body.view, view.body.legal_actions, view.body.odds, view.body.last_result],
        [200, SEAT_SCHEMA, seat, 'seat_not_open', null, [], null, null],
        `seat ${seat}`
      );
      const action = await post(`/seats/${seat}/action`, { label: 'fold' });
      assert.deepEqual([action.status, action.body.code], [409, 'SEAT_NOT_OPEN'], `seat ${seat}`);
    }
    // A long poll on a seat that will never open comes back at once.
    const closed = await withDeadline(get('/seats/5/view?wait=20000'), 5000, 'the seat_not_open view');
    assert.equal(closed.body.status, 'seat_not_open');
    const open = (await get('/seats/1/view')).body;
    assert.deepEqual([open.seat, open.status, open.hand_number], [1, 'waiting', 1]);

    for (const route of ['/seats/6/view', '/seats/7/view', '/seats/10/view', '/seats/-1/view', '/seats/1', '/seats/1/view/extra', '/seats//view']) {
      assert.equal((await get(route)).status, 404, route);
    }
    assert.equal((await post('/seats/6/action', { label: 'fold' })).status, 404);
    assert.equal((await post('/seats/1/view', {})).status, 404, 'a view is read, not posted');
    assert.throws(() => table.seatView(6), error => error.code === 'INVALID_INPUT' && /0 to 5/.test(error.message));
    assert.throws(() => table.seatAct(6, 'fold'), error => error.code === 'INVALID_INPUT');
    const state = (await get('/state')).body;
    assert.deepEqual([state.status, state.hand.log], ['your_turn', []], 'none of this touched the hand');
  });
});

test('seat protocol v2: at four seats an open seat sees three opponents, none of their cards, and no folded hand at the showdown', async () => {
  await withTable({ hands: 1 }, async ({ table, get, post, until, matches }) => {
    assert.equal((await post('/new', { players: ['human', 'agent', 'agent', 'agent'] })).status, 200);
    const cards = [null, null, null, null];
    const others = seat => cards.flatMap((held, other) => (other !== seat && held ? held : []));
    const seatTexts = [];
    // One decision for an open seat over HTTP. Whatever it is shown must not name another seat's cards.
    const play = async (seat, label) => {
      const turn = await withDeadline(get(`/seats/${seat}/view?wait=20000`), 5000, `seat ${seat}'s turn`);
      assert.equal(turn.body.status, 'your_turn', `seat ${seat}`);
      cards[seat] ??= turn.body.view.hole_cards;
      assert.deepEqual(turn.body.view.hole_cards, cards[seat]);
      seatTexts.push({ seat, text: turn.text });
      const reply = await post(`/seats/${seat}/action`, { label });
      assert.equal(reply.status, 200, reply.text);
      seatTexts.push({ seat, text: reply.text });
      return turn.body;
    };
    const human = async label => {
      const state = await until(current => current.status === 'your_turn');
      cards[0] ??= state.hand.cards[0];
      assert.deepEqual(state.hand.cards, [cards[0], null, null, null], 'the page shows the human\'s cards only');
      assert.equal((await post('/action', { label })).status, 200);
    };

    // Seat 0 has the button, seat 1 the small blind, seat 2 the big blind. Seat 3 folds first.
    const first = await play(3, 'fold');
    assert.deepEqual([first.view.position, first.view.players_in_hand, first.odds.opponents_in, first.situation.opponents_still_in], ['other', 4, 3, 'three']);
    await human('call');
    await play(1, 'call');
    const blind = await play(2, 'check');
    assert.deepEqual([blind.view.seats, blind.view.players_dealt_in, blind.view.players_in_hand, blind.view.position, blind.view.to_call, blind.view.pot], [4, 4, 3, 'big blind', 0, 300]);
    assert.deepEqual(blind.view.opponents, [
      { seat: 0, stack: STACK - 100, committed: 100, in_hand: true, all_in: false, is_button: true },
      { seat: 1, stack: STACK - 100, committed: 100, in_hand: true, all_in: false, is_button: false },
      { seat: 3, stack: STACK, committed: 0, in_hand: false, all_in: false, is_button: false }
    ], 'three opponents, each with chips and status and nothing else');
    assert.equal(blind.view.opponent_stack, STACK - 100);
    assert.deepEqual([blind.odds.opponents_in, blind.situation.opponents_still_in], [2, 'two'], 'the odds are against the two players still in');
    assert.match(blind.situation.game, /several players/);
    assert.deepEqual(Object.keys(blind.opponent_profiles), ['0', '1', '3']);
    assert.deepEqual(blind.view.actions.map(action => [action.seat, action.label]), [[3, 'fold'], [0, 'call'], [1, 'call']]);
    // Flop, turn and river: the two blinds and the button check it down.
    for (const street of ['flop', 'turn', 'river']) {
      assert.equal((await play(1, 'check')).view.street, street);
      await play(2, 'check');
      await human('check');
    }

    const over = await until(state => state.status === 'hand_over');
    const page = await get('/state');
    assert.deepEqual([over.hand.result.reason, over.hand.result.showdown, over.hand.result.pot, over.hand.folded], ['showdown', true, 300, [false, false, false, true]]);
    assert.deepEqual(page.body.hand.cards, [cards[0], cards[1], cards[2], null], 'the showdown turns over the three hands that reached it');
    assert.equal(page.body.hand.hand_names[3], null);
    assert.ok(page.body.hand.hand_names.slice(0, 3).every(name => typeof name === 'string'));
    for (const card of cards[3]) assert.ok(!mentionsCard(page.text, card), `the page state must not contain the folded ${card}`);

    // What each open seat is told about the hand: the public result, and the same three hands.
    for (const seat of [1, 2, 3]) {
      const after = await get(`/seats/${seat}/view`);
      const result = after.body.last_result;
      assert.deepEqual([after.body.status, after.body.view, result.hand_number, result.reason, result.pot], ['hand_over', null, 1, 'showdown', 300], `seat ${seat}`);
      assert.deepEqual(result.shown_cards, [cards[0], cards[1], cards[2], null], `seat ${seat}: a folded hand is never revealed`);
      assert.deepEqual([result.winners, result.you_won, result.your_net], [over.hand.result.winners, over.hand.result.winners.includes(seat), over.hand.result.net[seat]], `seat ${seat}`);
      assert.deepEqual([result.hand_names[3], result.board], [null, over.hand.board], `seat ${seat}`);
      for (const card of cards[3]) assert.ok(seat === 3 || !mentionsCard(after.text, card), `seat ${seat} must not be shown the folded ${card}`);
    }
    assert.deepEqual([over.hand.result.net[3], over.hand.result.winners.includes(3)], [0, false]);
    // The person's seat is not an agent's seat: it reports its status and nothing about the hand.
    const bottom = (await get('/seats/0/view')).body;
    assert.deepEqual([bottom.status, bottom.view, bottom.odds, bottom.last_result], ['seat_not_open', null, null, null]);

    assert.equal((await post('/next')).status, 200);
    await until(state => state.status === 'match_over');
    await table.finished();
    assert.deepEqual(matches[0].log[0].hole_cards, cards, 'each seat was shown its own two cards');
    assert.equal(new Set(cards.flat()).size, 8);
    // Before the showdown, nothing an open seat read held a card of any other seat.
    assert.equal(seatTexts.length, 2 * 9);
    for (const { seat, text } of seatTexts) {
      for (const card of others(seat)) assert.ok(!mentionsCard(text, card), `seat ${seat} must not be shown ${card}`);
    }
  });
});

test('model player plays a named legal label and lets the rule bot step in otherwise', async () => {
  const deck = deckDealing({ button: ['As', 'Ad'], other: ['7c', '2h'], board: ['2s', '9d', 'Jh', '3c', 'Qs'] });
  const view = seatView(startHand({ stacks: [200, 200], button: 0, deck }), 0);
  const prompts = [];
  const make = ask => createModelPlayer({
    name: 'Model',
    ask: async prompt => {
      prompts.push(prompt);
      return await ask(prompt);
    },
    random: seededRandom(6),
    iterations: 200
  });
  const ruleLabel = (await createRulePlayer({ random: seededRandom(6), iterations: 200 }).decide(view)).label;
  assert.match(ruleLabel, /^raise_/);

  const played = await make(async () => 'I will Call.\n').decide(view, {});
  assert.deepEqual([played.label, played.meta.source, played.meta.reply, played.meta.agrees_with_rule], ['call', 'agent', 'I will Call.', false]);
  const agreed = await make(async () => ruleLabel).decide(view, {});
  assert.deepEqual([agreed.label, agreed.meta.source, agreed.meta.agrees_with_rule], [ruleLabel, 'agent', true]);
  assert.match(prompts[0], /Your cards: As Ad/);
  assert.match(prompts[0], /nothing else: fold, call, raise_small, raise_large, all_in$/);
  for (const card of ['7c', '2h']) assert.ok(!mentionsCard(prompts[0], card), 'the brief never holds the other seat\'s cards');
  // An adapter may answer with the text and the model that really produced it.
  const named = await make(async () => ({ text: 'call', model: 'model-b-2026' })).decide(view, {});
  assert.deepEqual([named.label, named.meta.source, named.meta.model, played.meta.model], ['call', 'agent', 'model-b-2026', null]);

  // `check` is a real label, but it is not legal for the small blind facing the big blind.
  for (const reply of ['check', 'I would bet 50 chips', '', null]) {
    const invalid = await make(async () => reply).decide(view, {});
    assert.deepEqual([invalid.label, invalid.meta.source, invalid.meta.reason], [ruleLabel, 'fallback', 'invalid_response'], String(reply));
  }

  const failed = await make(async () => { throw Object.assign(new Error('Failed to authenticate'), { code: 'AGENT_CLI_ERROR' }); }).decide(view, {});
  assert.deepEqual([failed.label, failed.meta.source, failed.meta.reason], [ruleLabel, 'fallback', 'error']);
  assert.deepEqual([failed.meta.error, failed.meta.error_code], ['Failed to authenticate', 'AGENT_CLI_ERROR']);
  const crashed = await make(async () => { throw new Error('boom'); }).decide(view, {});
  assert.deepEqual([crashed.meta.reason, crashed.meta.error, crashed.meta.error_code], ['error', 'boom', 'UNKNOWN']);
  assert.throws(() => createModelPlayer({ name: 'Model' }), TypeError);
});

test('model player hands its turn\'s abort signal to the model call and describes a larger table', async () => {
  const hand = startHand({ stacks: [200, 200, 200, 200], button: 0, random: seededRandom(41) });
  const view = seatView(hand, hand.toAct);
  assert.equal(view.seat, 3);
  const calls = [];
  const player = createModelPlayer({
    name: 'Model',
    ask: async (prompt, options) => {
      calls.push({ prompt, options });
      return 'fold';
    },
    random: seededRandom(7),
    iterations: 60
  });
  const controller = new AbortController();
  const decision = await player.decide(view, { signal: controller.signal, opponentProfiles: {} });
  assert.equal(decision.label, 'fold');
  assert.equal(calls[0].options.signal, controller.signal, 'the adapter receives the very signal the turn clock aborts');
  await player.decide(view, {});
  assert.equal(calls[1].options.signal, undefined, 'no clock, no signal');

  // The brief says how many sit at the table and who they are, and still holds only this seat's cards.
  const [brief] = calls;
  assert.match(brief.prompt, /at a table of 4 players\. You are seat 3\./);
  assert.match(brief.prompt, /Opponents: seat 0 \(button\): 200 chips; seat 1: 199 chips; seat 2: 198 chips\./);
  assert.match(brief.prompt, /against 3 random hands/);
  assert.match(brief.prompt, new RegExp(`Your cards: ${hand.holeCards[3].join(' ')}`));
  for (const card of [0, 1, 2].flatMap(seat => hand.holeCards[seat])) assert.ok(!mentionsCard(brief.prompt, card), `the brief must not contain ${card}`);
});

test('parseAgentLabel takes the first legal label named as whole words', () => {
  const labels = ['fold', 'check', 'call', 'raise_small', 'raise_large', 'all_in'];
  assert.equal(parseAgentLabel('raise-small', labels), 'raise_small');
  assert.equal(parseAgentLabel('Call', labels), 'call');
  assert.equal(parseAgentLabel('all in', labels), 'all_in');
  assert.equal(parseAgentLabel('recall nothing', labels), null);
  assert.equal(parseAgentLabel('**Raise Large!**', labels), 'raise_large');
  assert.equal(parseAgentLabel('I fold. I would not call.', labels), 'fold');
  assert.equal(parseAgentLabel('call', ['fold', 'check']), null, 'only the labels that are legal now count');
  assert.equal(parseAgentLabel('', labels), null);
  assert.equal(parseAgentLabel(null, labels), null);
});

// A stand-in for `child_process.spawn`: records the call and answers once stdin is closed.
function fakeCli(respond) {
  const calls = [];
  const spawnFn = (binary, args, options) => {
    const call = { binary, args, options, input: undefined, killed: null };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = signal => {
      call.killed = signal;
    };
    child.stdin = {
      on() {},
      end(input) {
        call.input = input;
        setImmediate(async () => {
          const reply = await respond(call);
          if (!reply) return;
          if (reply.error) return child.emit('error', reply.error);
          if (reply.stdout) child.stdout.emit('data', reply.stdout);
          if (reply.stderr) child.stderr.emit('data', reply.stderr);
          return child.emit('close', reply.status ?? 0);
        });
      }
    };
    return child;
  };
  return { calls, spawnFn };
}

// The adapter makes one empty directory per `ask` function under the system temporary folder.
async function removeWorkDirs(...fakes) {
  for (const { calls } of fakes) {
    for (const { options } of calls) {
      if (/^jev-poker-(claude|codex)-/.test(path.basename(options.cwd))) await fs.rm(options.cwd, { recursive: true, force: true });
    }
  }
}

test('agent CLI adapter runs Claude with no tools and no shell, and reports its errors', async () => {
  const prompt = 'Reply with exactly one of these labels and nothing else: fold, call';
  const ok = fakeCli(() => ({ stdout: JSON.stringify({ is_error: false, result: 'call', modelUsage: { 'claude-test-1': {} } }) }));
  const plain = fakeCli(() => ({ stdout: JSON.stringify({ is_error: false, result: 'fold' }) }));
  const denied = fakeCli(() => ({ stdout: JSON.stringify({ is_error: true, result: 'Failed to authenticate' }) }));
  const garbled = fakeCli(() => ({ stdout: 'not json', stderr: 'crashed', status: 1 }));
  const missing = fakeCli(() => ({ error: new Error('spawn claude ENOENT') }));
  const silent = fakeCli(() => null);
  try {
    const ask = createAgentCliAsk({ kind: 'claude', model: 'test-model', spawnFn: ok.spawnFn });
    assert.deepEqual(await ask(prompt), { text: 'call', model: 'claude-test-1' }, 'reports the model that really answered');
    const [call] = ok.calls;
    assert.equal(call.binary, 'claude');
    const tools = call.args.indexOf('--tools');
    assert.ok(tools >= 0);
    assert.equal(call.args[tools + 1], '', '--tools is followed by an empty list');
    assert.equal(call.options.shell, false);
    for (const flag of ['-p', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(call.args.includes(flag), flag);
    assert.deepEqual(call.args.slice(-2), ['--model', 'test-model']);
    assert.equal(call.input, prompt, 'the prompt travels on stdin');
    assert.ok(!call.args.includes(prompt));
    assert.match(path.basename(call.options.cwd), /^jev-poker-claude-/);
    assert.deepEqual(await fs.readdir(call.options.cwd), [], 'the session runs in an empty directory');
    assert.equal((await ask(prompt)).text, 'call');
    assert.equal(ok.calls[1].options.cwd, call.options.cwd, 'one directory per ask function');
    // Without usage details the adapter falls back to the model it asked for, then to none.
    assert.deepEqual(await createAgentCliAsk({ kind: 'claude', model: 'asked-for', spawnFn: plain.spawnFn })(prompt), { text: 'fold', model: 'asked-for' });
    assert.deepEqual(await createAgentCliAsk({ kind: 'claude', spawnFn: plain.spawnFn })(prompt), { text: 'fold', model: null });

    const deniedAsk = createAgentCliAsk({ kind: 'claude', spawnFn: denied.spawnFn });
    await assert.rejects(() => deniedAsk(prompt), error => error.code === 'AGENT_CLI_ERROR' && /Failed to authenticate/.test(error.message));
    assert.ok(!denied.calls[0].args.includes('--model'), 'no model flag unless a model is named');
    assert.equal(denied.calls[0].args[denied.calls[0].args.indexOf('--tools') + 1], '');

    await assert.rejects(() => createAgentCliAsk({ kind: 'claude', spawnFn: garbled.spawnFn })(prompt), error => error.code === 'AGENT_CLI_ERROR' && /no usable answer/.test(error.message));
    await assert.rejects(() => createAgentCliAsk({ kind: 'claude', spawnFn: missing.spawnFn })(prompt), error => error.code === 'AGENT_CLI_ERROR' && /could not be started/.test(error.message));
    await assert.rejects(() => createAgentCliAsk({ kind: 'claude', timeoutMs: 20, spawnFn: silent.spawnFn })(prompt), error => error.code === 'AGENT_CLI_TIMEOUT');
    assert.equal(silent.calls[0].killed, 'SIGKILL');

    assert.throws(() => createAgentCliAsk({ kind: 'bash' }), TypeError);
    assert.throws(() => inspectAgentCli('bash'), TypeError);
  } finally {
    await removeWorkDirs(ok, plain, denied, garbled, missing, silent);
  }
});

test('agent CLI adapter runs Codex in a read-only sandbox and reads its answer file', async () => {
  const outputFile = call => call.args[call.args.indexOf('-o') + 1];
  const ok = fakeCli(async call => {
    await fs.writeFile(outputFile(call), 'raise_small\n');
    return { status: 0 };
  });
  const rejected = fakeCli(() => ({ status: 1, stderr: 'ERROR: {"error":{"message":"The model is not supported"}}\n' }));
  try {
    const answer = await createAgentCliAsk({ kind: 'codex', model: 'test-model', spawnFn: ok.spawnFn })('pick one');
    assert.equal(answer.text.trim(), 'raise_small');
    assert.equal(answer.model, 'test-model');
    const [call] = ok.calls;
    assert.deepEqual([call.binary, call.args[0], call.options.shell], ['codex', 'exec', false]);
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(call.args.includes('--ephemeral'));
    assert.equal(call.args[call.args.indexOf('-m') + 1], 'test-model');
    assert.equal(call.args[call.args.indexOf('-C') + 1], call.options.cwd);
    assert.match(call.args.at(-1), /pick one$/);
    assert.deepEqual(await fs.readdir(call.options.cwd), [], 'the answer file is removed once read');

    await assert.rejects(
      () => createAgentCliAsk({ kind: 'codex', spawnFn: rejected.spawnFn })('pick one'),
      error => error.code === 'AGENT_CLI_ERROR' && /The model is not supported/.test(error.message)
    );
  } finally {
    await removeWorkDirs(ok, rejected);
  }
});

test('agent CLI adapter kills the tool when its turn is cut off, and says so', async () => {
  const fakes = [];
  try {
    for (const kind of ['claude', 'codex']) {
      // The tool never answers. Its own time limit is short enough to end this test if the signal is ignored.
      const silent = fakeCli(() => null);
      fakes.push(silent);
      const ask = createAgentCliAsk({ kind, model: 'test-model', timeoutMs: 2000, spawnFn: silent.spawnFn });
      const controller = new AbortController();
      const outcome = assert.rejects(ask('pick one', { signal: controller.signal }), error => error.code === 'AGENT_CLI_ABORTED' && /ran out of time/.test(error.message));
      await waitFor(() => silent.calls.length === 1 && silent.calls[0].input !== undefined, `${kind} to start`);
      assert.equal(silent.calls[0].killed, null, `${kind} runs until the signal fires`);
      controller.abort();
      await withDeadline(outcome, 1500, `${kind} to be stopped`);
      assert.equal(silent.calls[0].killed, 'SIGKILL', `${kind} is killed, not left to finish an answer nobody will read`);
      assert.equal(silent.calls.length, 1);
    }
    // A signal that never fires changes nothing.
    const ok = fakeCli(() => ({ stdout: JSON.stringify({ is_error: false, result: 'call' }) }));
    fakes.push(ok);
    assert.equal((await createAgentCliAsk({ kind: 'claude', spawnFn: ok.spawnFn })('pick one', { signal: new AbortController().signal })).text, 'call');
    assert.equal(ok.calls[0].killed, null);
  } finally {
    await removeWorkDirs(...fakes);
  }
});

// A signal that is already aborted never fires again, so the adapter has to look at it before it
// starts the tool: the clock can run out while the adapter is still getting ready.
test('agent CLI adapter does not start the tool for a turn that is already over', async () => {
  const fakes = [];
  try {
    for (const kind of ['claude', 'codex']) {
      const fake = fakeCli(async call => {
        if (kind === 'codex') await fs.writeFile(call.args[call.args.indexOf('-o') + 1], 'call\n');
        return { stdout: JSON.stringify({ is_error: false, result: 'call' }) };
      });
      fakes.push(fake);
      const ask = createAgentCliAsk({ kind, spawnFn: fake.spawnFn });
      assert.equal((await ask('pick one')).text.trim(), 'call');
      const over = new AbortController();
      over.abort();
      // The stand-in would answer at once: an adapter that starts it anyway resolves instead of rejecting.
      await assert.rejects(() => ask('pick one', { signal: over.signal }), error => error.code === 'AGENT_CLI_ABORTED' && /ran out of time/.test(error.message), kind);
      assert.equal(fake.calls.length, 1, `${kind} is not started for the turn that is over`);
      assert.equal((await ask('pick one', { signal: new AbortController().signal })).text.trim(), 'call', 'the next turn is asked as usual');
      assert.equal(fake.calls.length, 2);
    }
  } finally {
    await removeWorkDirs(...fakes);
  }
});

test('examples/poker-agent.mjs waits for an open seat, then plays it to the end with legal labels', async () => {
  // The agent takes seat 2. The first game has two seats, so there is no such seat yet; the second
  // game on this table (seed 23) has three, with seat 2 open. The open seat's odds are estimated
  // with unseeded randomness, so the exact line of play is not asserted, only that every choice
  // was legal, explained and printed.
  const script = path.join(root, 'examples', 'poker-agent.mjs');
  await withTable({ hands: 6, seed: 22 }, async ({ table, url, post, until, matches }) => {
    await table.newGame({ players: ['human', 'rule'] });
    const child = spawn(process.execPath, [script, '--url', url, '--seat', '2'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const output = new EventEmitter();
    child.stdout.on('data', chunk => {
      stdout += chunk;
      output.emit('data');
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.on('close', code => resolve(code)));
    try {
      // Seat 2 is not at the table: the agent says how to open a seat and keeps polling.
      await withDeadline(new Promise(resolve => {
        const check = () => /--players you,agent/.test(stdout) && resolve();
        output.on('data', check);
        check();
      }), 15_000, 'the seat_not_open hint');

      await table.newGame({ players: ['rule', 'rule', 'agent'] });
      for (let step = 0; step < 20; step += 1) {
        const state = await until(current => ['hand_over', 'match_over'].includes(current.status), 20_000);
        if (state.status === 'match_over') break;
        assert.equal((await post('/next')).status, 200);
      }
      assert.equal(await withDeadline(exited, 15_000, 'the agent to exit'), 0, stderr);
      await table.finished();

      const match = matches.at(-1);
      assert.equal(match.seats, 3);
      const agentActions = match.log.flatMap(hand => hand.actions.filter(action => action.seat === 2).map(action => ({ hand: hand.hand_number, ...action })));
      assert.ok(match.hands_played >= 1 && agentActions.length > 0);
      assert.equal(match.illegal_actions, 0);
      for (const action of agentActions) {
        assert.equal(action.meta.source, 'agent');
        assert.match(action.meta.note, /% to win/);
      }
      const lines = stdout.split('\n').filter(line => /^hand \d+ /.test(line));
      assert.deepEqual(
        lines.map(line => line.match(/^hand (\d+) (\w+): (\w+) \(/).slice(1, 4)),
        agentActions.map(action => [String(action.hand), action.street, action.label]),
        'one printed line per decision'
      );
      assert.match(stdout, /^Playing seat 2 at /);
      assert.equal(stdout.match(/--players you,agent/g).length, 1, 'the hint is printed once');
      assert.match(stdout, /Match over\.\n$/);
    } finally {
      child.kill('SIGKILL');
    }
  });

  // A seat the table does not have is refused before anything is sent.
  for (const seat of ['6', '-1', '1.5', 'top']) {
    const refused = spawn(process.execPath, [script, '--url', 'http://127.0.0.1:9', '--seat', seat], { stdio: ['ignore', 'pipe', 'pipe'] });
    let complaint = '';
    refused.stderr.on('data', chunk => { complaint += chunk; });
    const code = await withDeadline(new Promise(resolve => refused.on('close', resolve)), 15_000, 'the agent to refuse the seat');
    assert.deepEqual([code, /--seat must be/.test(complaint)], [2, true], `--seat ${seat}: ${complaint}`);
  }
});
