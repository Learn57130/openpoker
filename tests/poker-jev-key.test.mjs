import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createJevKeyStore } from '../src/jev-key.mjs';
import { createRulePlayer } from '../src/players.mjs';
import { lanAddresses, startGuestServer } from '../src/server.mjs';
import { createTable } from '../src/table-session.mjs';

// The start screen's Jev key box: where the key is looked for, where "Remember" saves it, and that no
// answer the table gives ever carries it. The keys here are made up.

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, '..');
const bin = path.join(root, 'bin', 'openpoker.mjs');
const FAKE = 'fake_test_key_0123456789_not_a_real_one';
const OTHER = 'another_fake_key_9876543210_also_not_real';

async function scratch(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'openpoker-key-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'cwd');
  const data = path.join(base, 'data');
  await fs.mkdir(cwd);
  return { base, cwd, data };
}

const mode = async file => (await fs.stat(file)).mode & 0o777;

test('the key is looked for on the page, then the environment, then the files, in that order', async t => {
  const { cwd, data } = await scratch(t);
  const store = createJevKeyStore({ dataDir: data, cwd, env: {} });
  assert.deepEqual(await store.status(), { set: false, source: null, file: null, remembered: false, can_forget: false, remember_file: path.join(data, '.env').replace(os.homedir(), '~') });
  await assert.rejects(store.get(), error => error.code === 'MISSING_API_KEY');

  await fs.mkdir(data);
  await fs.writeFile(path.join(data, '.env'), `TYPESAFE_API_KEY=${OTHER}\n`);
  assert.equal(await store.get(), OTHER, 'the data folder\'s .env');
  assert.equal((await store.status()).can_forget, true, 'the file "Remember" writes can be cleared from the page');

  await fs.writeFile(path.join(cwd, '.env'), `TYPESAFE_API_KEY="${FAKE}"\n`);
  assert.equal(await store.get(), FAKE, '.env in the starting folder comes before the data folder');
  assert.equal((await store.status()).can_forget, false, 'a file the page does not write stays as it is');

  const withEnv = createJevKeyStore({ dataDir: data, cwd, env: { TYPESAFE_API_KEY: OTHER } });
  assert.equal(await withEnv.get(), OTHER, 'the environment comes before any file');
  assert.equal((await withEnv.status()).source, 'environment');
  await withEnv.set(FAKE);
  assert.equal(await withEnv.get(), FAKE, 'a key typed on the page comes first of all');
  assert.equal((await withEnv.status()).source, 'page');

  const explicit = createJevKeyStore({ envFile: path.join(cwd, 'nothing.env'), dataDir: data, cwd, env: {} });
  assert.equal(await explicit.has(), false, 'with --env-file only that file is read');
});

test('a key that could break the file or is not a key is refused, without repeating it', async t => {
  const { cwd, data } = await scratch(t);
  const store = createJevKeyStore({ dataDir: data, cwd, env: {} });
  for (const bad of ['short', `${FAKE}\nOTHER=1`, `${FAKE} x`, `"${FAKE}"`, `${FAKE}#`, 'x'.repeat(513), 42, null]) {
    await assert.rejects(store.set(bad, { remember: true }), error => error.code === 'INVALID_INPUT' && !error.message.includes(String(bad).slice(0, 12)));
  }
  assert.equal(await store.has(), false);
  await assert.rejects(fs.access(path.join(data, '.env')), 'nothing written');
});

test('"Remember" saves to the data folder, owner-only, keeping every other line, and "Remove" takes only its line', async t => {
  const { cwd, data } = await scratch(t);
  await fs.mkdir(data, { mode: 0o755 });
  const file = path.join(data, '.env');
  await fs.writeFile(file, `# my settings\nOTHER=1\nTYPESAFE_API_KEY=${OTHER}\n`, { mode: 0o644 });
  const store = createJevKeyStore({ dataDir: data, cwd, env: {} });

  const status = await store.set(FAKE, { remember: true });
  assert.ok(!JSON.stringify(status).includes(FAKE), 'the status never carries the key');
  assert.deepEqual([status.set, status.source, status.remembered, status.can_forget], [true, 'page', true, true]);
  assert.equal(await fs.readFile(file, 'utf8'), `# my settings\nOTHER=1\nTYPESAFE_API_KEY=${FAKE}\n`, 'the old key line is replaced, not repeated');
  assert.equal(await mode(file), 0o600);
  assert.equal(await mode(data), 0o700, 'the data folder is private, as for saved games');
  assert.equal(await createJevKeyStore({ dataDir: data, cwd, env: {} }).get(), FAKE, 'a new start finds the saved key');

  const after = await store.forget();
  assert.deepEqual([after.set, after.source], [false, null]);
  assert.equal(await fs.readFile(file, 'utf8'), '# my settings\nOTHER=1\n');

  const memoryOnly = await store.set(FAKE);
  assert.deepEqual([memoryOnly.remembered, memoryOnly.file], [false, null]);
  assert.equal(await fs.readFile(file, 'utf8'), '# my settings\nOTHER=1\n', 'without Remember nothing is written');
});

test('with --env-file, "Remember" writes that file and leaves its folder\'s permissions alone; a link is refused', async t => {
  const { base, cwd, data } = await scratch(t);
  const folder = path.join(base, 'edition');
  await fs.mkdir(folder, { mode: 0o755 });
  await fs.chmod(folder, 0o755);
  const envFile = path.join(folder, '.env');
  const store = createJevKeyStore({ envFile, dataDir: data, cwd, env: {} });
  await store.set(FAKE, { remember: true });
  assert.equal(await fs.readFile(envFile, 'utf8'), `TYPESAFE_API_KEY=${FAKE}\n`);
  assert.equal(await mode(envFile), 0o600);
  assert.equal(await mode(folder), 0o755);
  await assert.rejects(fs.access(path.join(data, '.env')));

  const target = path.join(base, 'target.env');
  await fs.writeFile(target, 'KEEP=1\n');
  const linked = path.join(folder, 'linked.env');
  await fs.symlink(target, linked);
  const linkedStore = createJevKeyStore({ envFile: linked, dataDir: data, cwd, env: {} });
  await assert.rejects(linkedStore.set(OTHER, { remember: true }), error => error.code === 'UNSAFE_OUTPUT');
  assert.equal(await fs.readFile(target, 'utf8'), 'KEEP=1\n', 'the link\'s target is untouched');
  assert.equal(await linkedStore.has(), false, 'a key that could not be saved is not used either');
});

// A real table started by the command, with no key anywhere and no AI tools on PATH.
async function serveTable(t, { cwd, data, base }, extra = []) {
  const tools = path.join(base, 'tools');
  await fs.mkdir(tools, { recursive: true });
  await fs.symlink(process.execPath, path.join(tools, 'node')).catch(() => {});
  const env = { ...process.env, PATH: tools, TYPESAFE_API_KEY: '', OPENPOKER_ADDONS: 'off' };
  const child = spawn(process.execPath, [bin, '--web', '--port', '0', '--output-dir', data, ...extra], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The table did not start: ${output}`)), 30_000);
    const read = chunk => {
      output += chunk;
      const started = output.match(/Poker table: (http:\/\/127\.0\.0\.1:\d+)\n/);
      if (started) {
        clearTimeout(timer);
        resolve(started[1]);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('close', code => reject(new Error(`The table exited with ${code}: ${output}`)));
  });
  return { url, output: () => output };
}

async function call(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.ok(!text.includes(FAKE), `${init?.method || 'GET'} ${new URL(url).pathname} never carries the key`);
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const jevOf = state => state.player_types.find(type => type.id === 'jev');

test('a running table takes a key from the start screen, makes Jev available, and never sends the key back', async t => {
  const dirs = await scratch(t);
  const table = await serveTable(t, dirs);
  const before = await call(`${table.url}/state`);
  assert.equal(jevOf(before.body).available, false);
  assert.match(jevOf(before.body).unavailable_reason, /Jev key box/);
  assert.equal((await call(`${table.url}/jev-key`)).body.set, false);
  const refused = await call(`${table.url}/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ players: ['human', 'jev'] }) });
  assert.equal(refused.body.code, 'PLAYER_UNAVAILABLE');

  const bad = await call(`${table.url}/jev-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'not a key' }) });
  assert.deepEqual([bad.status, bad.body.code], [400, 'INVALID_INPUT']);

  const set = await call(`${table.url}/jev-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: FAKE, remember: true }) });
  assert.equal(set.status, 200);
  assert.deepEqual([set.body.set, set.body.source, set.body.remembered], [true, 'page', true]);
  assert.equal(jevOf((await call(`${table.url}/state`)).body).available, true, 'Jev is available without a restart');
  const saved = path.join(dirs.data, '.env');
  assert.equal(await fs.readFile(saved, 'utf8'), `TYPESAFE_API_KEY=${FAKE}\n`);
  assert.equal(await mode(saved), 0o600);

  // You hold the button and act first; with no turn limit Jev is never asked, so nothing leaves this computer.
  const dealt = await call(`${table.url}/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ players: ['human', 'jev'], turn_limit_ms: 0 }) });
  assert.equal(dealt.status, 200, JSON.stringify(dealt.body));
  assert.equal(dealt.body.players[1].type, 'jev');
  assert.equal((await call(`${table.url}/state`)).body.hand.acting, 0);
  await call(`${table.url}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  const removed = await call(`${table.url}/jev-key`, { method: 'DELETE' });
  assert.deepEqual([removed.body.set, removed.body.source], [false, null]);
  assert.equal(await fs.readFile(saved, 'utf8'), '');
  assert.equal(jevOf((await call(`${table.url}/state`)).body).available, false);
  assert.ok(!table.output().includes(FAKE), 'the key is never printed');

  // Another website's page cannot set or clear a key on this table.
  const foreign = await call(`${table.url}/jev-key`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ key: OTHER }) });
  assert.equal(foreign.status, 403);
  assert.equal((await call(`${table.url}/jev-key`)).body.set, false);
});

test('openpoker doctor finds a key saved in the data folder and does not print it', async t => {
  const { cwd, data } = await scratch(t);
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, '.env'), `TYPESAFE_API_KEY=${FAKE}\n`, { mode: 0o600 });
  const env = { ...process.env, TYPESAFE_API_KEY: '', OPENPOKER_ADDONS: 'off' };
  const { stdout } = await execFile(process.execPath, [bin, 'doctor', '--port', '58788', '--output-dir', data, '--format', 'json'], { cwd, env });
  assert.equal(JSON.parse(stdout).players.jev.ready, true);
  assert.ok(!stdout.includes(FAKE));
  const text = (await execFile(process.execPath, [bin, 'doctor', '--port', '58788', '--output-dir', data], { cwd, env })).stdout;
  assert.ok(!text.includes(FAKE));
});

test('another computer and the tunnel\'s guest listener cannot reach the key box', async t => {
  const [ip] = lanAddresses();
  if (ip) {
    const dirs = await scratch(t);
    const table = await serveTable(t, dirs, ['--lan']);
    const remote = table.url.replace('127.0.0.1', ip);
    for (const init of [{}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: FAKE }) }, { method: 'DELETE' }]) {
      assert.equal((await call(`${remote}/jev-key`, init)).status, 403, `${init.method || 'GET'} from the home network`);
    }
    assert.equal((await call(`${table.url}/jev-key`)).body.set, false);
  } else {
    t.diagnostic('this computer has no home-network address; the --lan part is skipped');
  }

  const table = createTable({
    playerTypes: [{ id: 'human', name: 'You', category: 'human', available: true }, { id: 'rule', name: 'Bot', category: 'bot', available: true }],
    createPlayer: () => createRulePlayer({ name: 'Bot' }),
    botDelayMs: 0,
    turnLimitMs: 0
  });
  const guest = await startGuestServer({ table });
  t.after(() => guest.close());
  const hostname = 'example-tunnel.trycloudflare.com';
  guest.allowHost(hostname);
  for (const method of ['GET', 'POST', 'DELETE']) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: guest.port, path: '/jev-key', method, headers: { Host: hostname, Origin: `https://${hostname}`, 'Content-Type': 'application/json' } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end(method === 'POST' ? JSON.stringify({ key: FAKE }) : undefined);
    });
    assert.equal(status, 404, `${method} through the tunnel`);
  }
});
