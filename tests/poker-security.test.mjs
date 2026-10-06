import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { secureRandom, seededRandom } from '../src/cards.mjs';
import { preparePrivateDirectory } from '../src/lib/files.mjs';
import { createRulePlayer } from '../src/players.mjs';
import { startTableServer } from '../src/server.mjs';
import { createTable } from '../src/table-session.mjs';

// Findings of the security review before the first public release, one test each.

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, '..');
const PLAYER_TYPES = Object.freeze([
  { id: 'human', name: 'You', category: 'human', available: true },
  { id: 'rule', name: 'Bot', category: 'bot', available: true },
  { id: 'agent', name: 'Open seat', category: 'agent', available: true },
  { id: 'friend', name: 'Friend', category: 'friend', available: true },
  { id: 'claude', name: 'Claude', category: 'agent', available: false }
]);

function openTable(overrides = {}) {
  return createTable({
    playerTypes: PLAYER_TYPES,
    createPlayer: (type, context) => createRulePlayer({ name: 'Bot', random: seededRandom(context.seed + context.seat), iterations: 30 }),
    hands: 3,
    botDelayMs: 0,
    turnLimitMs: 0,
    ...overrides
  });
}

function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('a played table deals from a secure source, and a shared table refuses a fixed seed', async () => {
  const draw = secureRandom();
  const values = Array.from({ length: 2000 }, draw);
  assert.ok(values.every(value => value >= 0 && value < 1));
  assert.ok(new Set(values).size > 1990, 'no repeating stream');
  for (const flag of ['--lan', '--tunnel']) {
    await assert.rejects(
      execFile(process.execPath, [path.join(root, 'bin', 'openpoker.mjs'), '--web', flag, '--seed', '7', '--port', '0'], { cwd: root, env: { ...process.env, OPENPOKER_ADDONS: 'off' } }),
      error => error.code === 2 && /--seed cannot be used with --lan or --tunnel/.test(error.stderr)
    );
  }
});

test('two tables without a seed deal different cards even when their game seeds match', async () => {
  const original = Math.random;
  // The same game seed for both tables: the deal must still differ, because the deck no longer comes from it.
  Math.random = () => 0.5;
  const tables = [openTable(), openTable()];
  try {
    for (const table of tables) await table.newGame({ players: ['human', 'rule'] });
  } finally {
    Math.random = original;
  }
  try {
    assert.equal(tables[0].snapshot().seed, tables[1].snapshot().seed);
    const hands = await Promise.all(tables.map(table => waitFor(() => table.snapshot().hand?.cards?.[0])));
    assert.notDeepEqual(hands[0], hands[1]);
  } finally {
    for (const table of tables) table.stop();
  }
});

test('the open-seat view shows nothing of a friend\'s cards', async () => {
  const table = openTable();
  try {
    await table.newGame({ players: ['rule', { type: 'friend', name: 'Ann' }] });
    await waitFor(() => table.guestSnapshot(1).status === 'your_turn');
    const view = table.seatView(1);
    assert.equal(view.status, 'seat_not_open');
    assert.deepEqual([view.view, view.situation, view.odds, view.legal_actions], [null, null, null, []]);
  } finally {
    table.stop();
  }
});

test('a seat link stops working when someone else sits there, and survives a redeal with the same friend', async () => {
  const table = openTable();
  try {
    await table.newGame({ players: ['human', { type: 'friend', name: 'Ann' }] });
    const annKey = table.seatKey(1);
    await table.newGame({ players: ['human', { type: 'friend', name: 'Ann' }] });
    assert.equal(table.seatKey(1), annKey, 'Deal again with Ann: her link still works');
    await table.newGame({ players: ['human', { type: 'friend', name: 'Bob' }] });
    assert.notEqual(table.seatKey(1), annKey);
    assert.equal(table.seatForKey(annKey), null, 'Ann\'s old link opens nothing');
  } finally {
    table.stop();
  }
});

test('odd requests get plain refusals, the page cannot be framed, and a friend\'s view hides the host\'s tools', async () => {
  const table = openTable();
  const server = await startTableServer({ table, port: 0 });
  try {
    await table.newGame({ players: ['human', { type: 'friend', name: 'Ann' }] });
    const key = table.seatKey(1);
    const odd = await fetch(`${server.url}/guest/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seat-Key': key }, body: JSON.stringify({ label: { toString: 1 } }) });
    assert.equal(odd.status, 400);
    assert.equal((await odd.json()).code, 'ILLEGAL_ACTION');
    const page = await fetch(`${server.url}/`);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const seen = table.guestSnapshot(1);
    assert.deepEqual(seen.player_types.map(type => type.id).sort(), ['friend', 'human'], 'only the types at this table');
    assert.ok(seen.player_types.every(type => type.available === true));
    assert.equal(seen.learner_enabled, false);
  } finally {
    await server.close();
  }
});

test('a symbolic link in place of the data folder is refused before any permission changes', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'openpoker-link-'));
  try {
    const target = path.join(base, 'target');
    await fs.mkdir(target, { mode: 0o755 });
    await fs.chmod(target, 0o755);
    const link = path.join(base, 'link');
    await fs.symlink(target, link);
    await assert.rejects(preparePrivateDirectory(link), error => error.code === 'UNSAFE_OUTPUT');
    assert.equal((await fs.stat(target)).mode & 0o777, 0o755, 'the link\'s target keeps its permissions');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
