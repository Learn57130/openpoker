import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { seededRandom } from '../src/cards.mjs';
import { createRulePlayer } from '../src/players.mjs';
import { startGuestServer, startTableServer } from '../src/server.mjs';
import { createTable } from '../src/table-session.mjs';
import { startQuickTunnel } from '../src/tunnel.mjs';

const TUNNEL_HOST = 'often-radios-ozone-morris.trycloudflare.com';
const PLAYER_TYPES = Object.freeze([
  { id: 'human', name: 'You', category: 'human', available: true },
  { id: 'rule', name: 'Bot', category: 'bot', available: true },
  { id: 'friend', name: 'Friend', category: 'friend', available: true }
]);

function openTable() {
  return createTable({
    playerTypes: PLAYER_TYPES,
    createPlayer: (type, context) => createRulePlayer({ name: 'Bot', random: seededRandom(context.seed + context.seat), iterations: 30 }),
    hands: 3,
    seed: 17,
    botDelayMs: 0,
    turnLimitMs: 0
  });
}

// A request as cloudflared makes it: from this computer, naming the tunnel's host. Node's fetch cannot set Host.
function call(port, { method = 'GET', path = '/', host = TUNNEL_HOST, headers = {}, body = null, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
      if (stream) {
        resolve({ status: response.statusCode, type: response.headers['content-type'], close: () => request.destroy() });
        return;
      }
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'], location: response.headers.location, text }));
    });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}

test('the guest listener treats every request as a guest, even one from this computer', async () => {
  const table = openTable();
  const guest = await startGuestServer({ table });
  try {
    await table.newGame({ players: ['human', { type: 'friend', name: 'Ann' }, 'rule'] });
    const key = table.seatKey(1);

    // Nothing is answered before the tunnel's host name is known.
    assert.equal((await call(guest.port, { path: '/play' })).status, 403);
    guest.allowHost(TUNNEL_HOST);
    assert.equal((await call(guest.port, { path: '/play', host: 'evil.example' })).status, 403, 'any other host name is refused');
    assert.equal((await call(guest.port, { path: '/play', host: `${TUNNEL_HOST}:8787` })).status, 403);

    // Owner routes do not exist here, though every request comes from 127.0.0.1.
    for (const [method, path] of [['GET', '/state'], ['POST', '/new'], ['POST', '/close'], ['POST', '/next'], ['POST', '/action'], ['GET', '/personas'], ['GET', '/games'], ['GET', '/learner'], ['GET', '/invites'], ['GET', '/seats/2/view'], ['POST', '/seats/2/action']]) {
      const answer = await call(guest.port, { method, path, body: method === 'POST' ? { label: 'fold' } : null });
      assert.equal(answer.status, 404, `${method} ${path}`);
    }
    assert.equal(table.snapshot().status === 'match_over', false, 'the game is still running');

    // A bare address goes to the friend's page (served at `/` the page would run as the host's), then their seat by its key.
    const bare = await call(guest.port, { path: '/' });
    assert.deepEqual([bare.status, bare.location], [302, '/play']);
    const page = await call(guest.port, { path: '/play' });
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.equal((await call(guest.port, { path: '/guest/state', headers: { 'X-Seat-Key': 'not-a-key' } })).status, 401);
    const seen = JSON.parse((await call(guest.port, { path: '/guest/state', headers: { 'X-Seat-Key': key } })).text);
    assert.equal(seen.guest.name, 'Ann');
    assert.equal(seen.players[0].name, 'Ann', 'the friend\'s own seat is drawn as seat 0');
    assert.deepEqual([seen.seed === table.snapshot().seed, seen.seed], [false, 1], 'the game number, never the seed that would rebuild the deck');

    // A write from another site is refused; one from the tunnel's own page reaches the table.
    const foreign = await call(guest.port, { method: 'POST', path: '/guest/action', headers: { 'X-Seat-Key': key, Origin: 'https://evil.example' }, body: { label: 'fold' } });
    assert.equal(foreign.status, 403);
    const own = await call(guest.port, { method: 'POST', path: '/guest/action', headers: { 'X-Seat-Key': key, Origin: `https://${TUNNEL_HOST}` }, body: { label: 'fold' } });
    assert.ok([200, 409].includes(own.status), `the table answered the move (${own.status})`);

    // No change-notice stream through the tunnel: the friend's page reads its state instead.
    assert.equal((await call(guest.port, { path: '/events' })).status, 404);
  } finally {
    table.stop();
    await guest.close();
  }
});

test('the owner\'s invitations use the tunnel address while it is open', async () => {
  const table = openTable();
  let tunnelState = { state: 'open', url: `https://${TUNNEL_HOST}`, hostname: TUNNEL_HOST, reason: null };
  const server = await startTableServer({ table, port: 0, tunnel: { status: () => ({ ...tunnelState }) } });
  try {
    await table.newGame({ players: ['human', { type: 'friend', name: 'Ann' }] });
    const invites = await (await fetch(`${server.url}/invites`)).json();
    assert.equal(invites.tunnel, true);
    assert.equal(invites.links[0].url, `https://${TUNNEL_HOST}/play#key=${table.seatKey(1)}`);
    const state = await (await fetch(`${server.url}/state`)).json();
    assert.deepEqual([state.tunnel.enabled, state.tunnel.state, state.tunnel.url], [true, 'open', `https://${TUNNEL_HOST}`]);

    // A tunnel that dropped offers no link: a new one would have a new address.
    tunnelState = { ...tunnelState, state: 'closed', reason: 'cloudflared stopped with status 1' };
    const after = await (await fetch(`${server.url}/invites`)).json();
    assert.deepEqual([after.tunnel, after.links[0].url], [false, null]);
  } finally {
    await server.close();
  }
});

// A stand-in for cloudflared: `script(child)` decides what it prints and when it exits.
function fakeCloudflared(script) {
  const calls = [];
  const spawnFn = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.kill = signal => {
      child.killed = true;
      setImmediate(() => child.emit('close', null, signal));
    };
    calls.push({ binary, args, options, child });
    setImmediate(() => script(child));
    return child;
  };
  return { calls, spawnFn };
}

const ANNOUNCED = `2026-10-05T07:05:23Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n2026-10-05T07:05:23Z INF |  https://${TUNNEL_HOST}                                       |\n`;

test('a quick tunnel reports its address, keeps away from the owner\'s cloudflared config, and stops', async () => {
  const fake = fakeCloudflared(child => child.stderr.emit('data', ANNOUNCED));
  const tunnel = startQuickTunnel({ port: 54321, spawnFn: fake.spawnFn });
  assert.equal(tunnel.status().state, 'starting');
  assert.deepEqual(await tunnel.ready, { url: `https://${TUNNEL_HOST}`, hostname: TUNNEL_HOST });
  assert.deepEqual([tunnel.status().state, tunnel.status().url], ['open', `https://${TUNNEL_HOST}`]);
  const [run] = fake.calls;
  assert.equal(run.binary, 'cloudflared');
  assert.equal(run.options.shell, false);
  assert.deepEqual([run.args[0], run.args[run.args.indexOf('--url') + 1]], ['tunnel', 'http://127.0.0.1:54321']);
  const config = run.args[run.args.indexOf('--config') + 1];
  assert.ok(!config.includes('.cloudflared'), 'a temporary config, not ~/.cloudflared/config.yml');
  assert.equal(await fs.readFile(config, 'utf8'), 'no-autoupdate: true\n');
  tunnel.stop();
  assert.equal(run.child.killed, true);
  assert.equal(tunnel.status().state, 'closed');
  tunnel.stop();

  // A tunnel that drops while the table runs says so.
  const dropping = fakeCloudflared(child => {
    child.stderr.emit('data', ANNOUNCED);
    setTimeout(() => {
      child.stderr.emit('data', '2026-10-05T07:09:00Z ERR Connection terminated connIndex=0\n');
      child.emit('close', 1);
    }, 10);
  });
  const dropped = startQuickTunnel({ port: 1, spawnFn: dropping.spawnFn });
  await dropped.ready;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual([dropped.status().state, dropped.status().reason], ['closed', 'Connection terminated connIndex=0']);
});

test('a quick tunnel that cannot open says why', async () => {
  const missing = fakeCloudflared(child => child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' })));
  const none = startQuickTunnel({ port: 1, spawnFn: missing.spawnFn });
  await assert.rejects(none.ready, /cloudflared is not installed/);
  assert.equal(none.status().state, 'failed');

  const refused = fakeCloudflared(child => {
    child.stderr.emit('data', '2026-10-05T07:05:17Z INF Requesting new quick Tunnel on trycloudflare.com...\n2026-10-05T07:05:18Z ERR failed to request quick Tunnel: 429 Too Many Requests\n');
    child.emit('close', 1);
  });
  await assert.rejects(startQuickTunnel({ port: 1, spawnFn: refused.spawnFn }).ready, /failed to request quick Tunnel: 429/);

  const silent = fakeCloudflared(() => {});
  const slow = startQuickTunnel({ port: 1, spawnFn: silent.spawnFn, timeoutMs: 50 });
  await assert.rejects(slow.ready, /gave no address within/);
  assert.equal(silent.calls[0].child.killed, true);

  // Stopped before it opened: `ready` settles rather than hanging.
  const pending = fakeCloudflared(() => {});
  const early = startQuickTunnel({ port: 1, spawnFn: pending.spawnFn });
  await new Promise(resolve => setTimeout(resolve, 20));
  early.stop();
  await assert.rejects(early.ready, /stopped before it opened/);
});
