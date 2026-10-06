import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SEATS } from './engine.mjs';

const PAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'table.html');
// Room for six seats, each with a model name and a 200-character style note.
const MAX_BODY_BYTES = 8192;
const PAGE_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  // No other site may show the table inside its own page (clickjacking).
  'X-Frame-Options': 'DENY'
});

function failure(response, error) {
  const status = error.status || STATUS_BY_CODE[error.code] || 500;
  if (status >= 500) {
    console.error(error);
    return send(response, status, { error: 'The table hit an unexpected error', code: 'INTERNAL' });
  }
  return send(response, status, { error: String(error.message || error).slice(0, 300), code: error.code || null });
}

function send(response, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(payload);
}

async function readJsonBody(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
    throw Object.assign(new Error('Requests must be application/json'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw Object.assign(new Error('Request body is not valid JSON'), { status: 400 });
  }
}

const MAX_LONG_POLL_MS = 25_000;
// What a computer other than this one may ask for, with `--lan`: the friend's page, the change notices and its own seat.
const GUEST_ROUTES = new Set(['GET /play', 'GET /events', 'GET /guest/state', 'POST /guest/action', 'POST /guest/next']);
// Change-notice streams other computers may hold open at once on the host's port (--lan); this computer's own are not counted.
const MAX_REMOTE_STREAMS = 50;
let remoteStreams = 0;

// Change notices: the table's version number now and after every change.
function streamEvents(request, response, table) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
  response.write(`data: ${table.snapshot().version}\n\n`);
  const unsubscribe = table.subscribe(version => response.write(`data: ${version}\n\n`));
  request.on('close', unsubscribe);
}

// A friend's page and seat, the same on the owner's port (`--lan`) and on the guest listener behind a tunnel.
// Returns false for any other route.
async function guestRoute(route, request, response, table) {
  if (route === 'GET /play') {
    send(response, 200, await fs.readFile(PAGE_PATH), PAGE_HEADERS);
    return true;
  }
  // The key from the friend's link opens that seat and nothing else.
  if (route === 'GET /guest/state' || route === 'POST /guest/action' || route === 'POST /guest/next') {
    const seat = table.seatForKey(request.headers['x-seat-key']);
    if (seat === null) send(response, 401, { error: 'This seat link is not valid. Ask the host for a new one.', code: 'BAD_SEAT_KEY' });
    else if (route === 'GET /guest/state') send(response, 200, table.guestSnapshot(seat));
    else if (route === 'POST /guest/action') send(response, 200, table.friendAct(seat, (await readJsonBody(request)).label));
    else {
      // Dealing the next hand is a friend's only other move, and only when the host has no seat.
      await readJsonBody(request);
      send(response, 200, table.friendNext(seat));
    }
    return true;
  }
  return false;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// Home-network ranges (10/8, 172.16/12, 192.168/16) come first, so a link uses the Wi-Fi address rather than, say, a VPN's.
const isHomeRange = address => /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address);

/** This computer's addresses on the home network (IPv4, not loopback), for the friends' links, Wi-Fi ranges first. */
export function lanAddresses() {
  const addresses = Object.values(os.networkInterfaces()).flat().filter(entry => entry && entry.family === 'IPv4' && !entry.internal).map(entry => entry.address);
  return [...addresses.filter(isHomeRange), ...addresses.filter(address => !isHomeRange(address))];
}
const STATUS_BY_CODE = Object.freeze({ NOT_RUNNING: 409, NAME_TAKEN: 409, PERSONA_LIMIT: 409, PERSONA_IN_USE: 409, PERSONA_NOT_FOUND: 404, PERSONAS_DISABLED: 404, GAME_NOT_FOUND: 404, HISTORY_DISABLED: 404, POLICY_NOT_FOUND: 404, LEARNER_DISABLED: 404, SEAT_NOT_FRIEND: 404, HOST_DEALS: 403, SEAT_NOT_OPEN: 409, NOT_YOUR_TURN: 409, NOT_WAITING: 409, ILLEGAL_ACTION: 400, INVALID_INPUT: 400, PLAYER_UNAVAILABLE: 409, MISSING_API_KEY: 409 });

/**
 * Local HTTP front end for one poker table. It listens on the loopback interface only, serves a
 * single page, and accepts nothing from a client except an action label, a short note, a turn
 * limit, or two to six seats (a player-type id, optionally with a model name). `/state`, `/action`, `/next` and `/new` serve the page; `/seats/N/view` and
 * `/seats/N/action` serve an external agent sitting in an open seat.
 */
export async function startTableServer({ table, port = 8787, host = '127.0.0.1', lan = false, tunnel = null, pageExtras = '' }) {
  await fs.access(PAGE_PATH);
  const server = http.createServer(async (request, response) => {
    try {
      const address = server.address();
      const allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
      // On the home network, friends reach this computer by its network address or its .local name.
      if (lan) {
        for (const ip of lanAddresses()) allowedHosts.add(`${ip}:${address.port}`);
        const name = os.hostname().replace(/\.local$/i, '');
        allowedHosts.add(`${name}.local:${address.port}`.toLowerCase());
      }
      if (request.headers.host) request.headers.host = request.headers.host.toLowerCase();
      // Refuse other host names (DNS rebinding) and cross-site writes.
      if (!allowedHosts.has(request.headers.host)) return send(response, 403, { error: 'Unknown host' });
      const origin = request.headers.origin;
      if (request.method !== 'GET' && origin && !allowedHosts.has(origin.replace(/^http:\/\//, ''))) return send(response, 403, { error: 'Cross-site request refused' });
      let url;
      try {
        url = new URL(request.url, 'http://local');
      } catch {
        return send(response, 400, { error: 'Bad request' });
      }
      const route = `${request.method} ${url.pathname}`;
      // Only this computer runs the table; another one may only play its own seat.
      if (!isLoopback(request.socket.remoteAddress) && !GUEST_ROUTES.has(route)) return send(response, 403, { error: 'Only the computer running the table can do that', code: 'OWNER_ONLY' });

      // The host's page, with an add-on's own part (if one is installed) after the page's script.
      if (route === 'GET /') {
        const html = await fs.readFile(PAGE_PATH, 'utf8');
        const end = html.lastIndexOf('</body>');
        return send(response, 200, pageExtras && end >= 0 ? `${html.slice(0, end)}${pageExtras}\n${html.slice(end)}` : html, PAGE_HEADERS);
      }
      if (route === 'GET /state') return send(response, 200, { ...table.snapshot(), lan: lan ? { enabled: true, port: address.port, addresses: lanAddresses() } : { enabled: false }, tunnel: tunnel ? { enabled: true, ...tunnel.status() } : { enabled: false } });
      if (await guestRoute(route, request, response, table)) return undefined;
      // The owner's invitations: a link for every friend seat in the current game. A tunnel's link works
      // from anywhere, the same Wi-Fi included, so it comes first.
      if (route === 'GET /invites') {
        const open = tunnel?.status().state === 'open' ? tunnel.status().url : null;
        const base = open ?? (lan && lanAddresses()[0] ? `http://${lanAddresses()[0]}:${address.port}` : null);
        return send(response, 200, { lan, tunnel: Boolean(open), links: table.friendSeats().map(({ seat, name }) => ({ seat, name, url: base ? `${base}/play#key=${table.seatKey(seat)}` : null })) });
      }
      if (route === 'GET /events') {
        if (isLoopback(request.socket.remoteAddress)) return streamEvents(request, response, table);
        if (remoteStreams >= MAX_REMOTE_STREAMS) return send(response, 503, { error: 'Too many open connections' });
        remoteStreams += 1;
        request.on('close', () => { remoteStreams -= 1; });
        return streamEvents(request, response, table);
      }
      if (route === 'POST /action') return send(response, 200, table.act((await readJsonBody(request)).label));
      if (route === 'POST /next') {
        await readJsonBody(request);
        return send(response, 200, table.next());
      }
      if (route === 'POST /new') {
        const body = await readJsonBody(request);
        const options = {};
        if (Array.isArray(body.players)) {
          options.players = body.players.slice(0, MAX_SEATS + 1).map(entry => (entry && typeof entry === 'object' && entry.persona !== undefined && entry.persona !== null ? { persona: entry.persona } : entry && typeof entry === 'object' ? { type: String(entry.type), model: entry.model ?? null, reasoning: entry.reasoning ?? null, style: entry.style ?? null, style_note: entry.style_note ?? null, name: entry.name ?? null } : String(entry)));
        }
        if (body.turn_limit_ms !== undefined) options.turnLimitMs = body.turn_limit_ms;
        return send(response, 200, await table.newGame(options));
      }
      if (route === 'POST /close') {
        await readJsonBody(request);
        return send(response, 200, await table.close());
      }
      // Saved personas: named players with a rating and a history log.
      if (route === 'GET /personas') return send(response, 200, { personas: await table.personas() });
      if (route === 'POST /personas') {
        const body = await readJsonBody(request);
        return send(response, 201, { persona: await table.createPersona(body) });
      }
      const personaRoute = url.pathname.match(/^\/personas\/([A-Za-z0-9-]{1,40})$/);
      if (personaRoute && request.method === 'GET') return send(response, 200, { persona: await table.persona(personaRoute[1]) });
      if (personaRoute && request.method === 'DELETE') return send(response, 200, await table.removePersona(personaRoute[1]));
      // The game history log: saved games and the one being played, hand by hand.
      if (route === 'GET /games') return send(response, 200, await table.games());
      const gameRoute = url.pathname.match(/^\/games\/([A-Za-z0-9-]{1,40})$/);
      if (gameRoute && request.method === 'GET') return send(response, 200, { game: await table.game(gameRoute[1]) });
      // An add-on's dashboard data, when one is installed.
      if (route === 'GET /learner') return send(response, 200, { policies: await table.learnerPolicies() });
      const learnerRoute = url.pathname.match(/^\/learner\/([A-Za-z0-9-]{1,40})$/);
      if (learnerRoute && request.method === 'GET') return send(response, 200, { policy: await table.learnerPolicy(learnerRoute[1]) });
      // Open seats for external agents: read the seat's own view, answer with one legal label.
      const seatRoute = url.pathname.match(/^\/seats\/([0-5])\/(view|action)$/);
      if (seatRoute && request.method === 'GET' && seatRoute[2] === 'view') {
        const seat = Number(seatRoute[1]);
        const wait = Math.min(MAX_LONG_POLL_MS, Math.max(0, Number(url.searchParams.get('wait')) || 0));
        if (wait > 0) await table.waitForSeat(seat, wait);
        return send(response, 200, table.seatView(seat));
      }
      if (seatRoute && request.method === 'POST' && seatRoute[2] === 'action') {
        const body = await readJsonBody(request);
        return send(response, 200, table.seatAct(Number(seatRoute[1]), body.label, body.note));
      }
      return send(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.status || STATUS_BY_CODE[error.code] || 500;
      return failure(response, error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // `--lan` listens on every IPv4 interface; otherwise only on this computer.
    server.listen(port, lan ? '0.0.0.0' : host, resolve);
  });
  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    async close() {
      table.stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

/**
 * The listener a tunnel connects to. `cloudflared` runs on this computer, so every request it forwards
 * comes from loopback; this listener therefore treats every request as a guest's, whatever its address,
 * and answers only the friend's page, the change notices and a seat opened by its key. It accepts one
 * host name, the tunnel's, and nothing before `allowHost` names it.
 */
export async function startGuestServer({ table }) {
  await fs.access(PAGE_PATH);
  let hostname = null;
  const server = http.createServer(async (request, response) => {
    try {
      const host = String(request.headers.host || '').toLowerCase();
      if (!hostname || host !== hostname) return send(response, 403, { error: 'Unknown host' });
      const origin = request.headers.origin;
      if (request.method !== 'GET' && origin && origin.toLowerCase() !== `https://${hostname}`) return send(response, 403, { error: 'Cross-site request refused' });
      let url;
      try {
        url = new URL(request.url, 'http://guest');
      } catch {
        return send(response, 400, { error: 'Bad request' });
      }
      const route = `${request.method} ${url.pathname}`;
      // A bare tunnel address goes to the friend's page, which asks for a seat link. Served at `/` the page
      // would run as the host's and break on the host-only routes this listener refuses.
      if (route === 'GET /') return send(response, 302, '', { Location: '/play' });
      // No change-notice stream here: a quick tunnel holds it back anyway, and the friend's page reads its seat's
      // state every 1.5 s instead. Without it, nobody holding the address can tie up connections.
      if (await guestRoute(route, request, response, table)) return undefined;
      return send(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.status || STATUS_BY_CODE[error.code] || 500;
      return failure(response, error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    port: server.address().port,
    allowHost(name) {
      hostname = String(name).toLowerCase();
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
