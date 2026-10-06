import assert from 'node:assert/strict';
import test from 'node:test';
import { seededRandom } from '../src/cards.mjs';
import { gameDetail } from '../src/game-history.mjs';
import { playMatch } from '../src/match.mjs';
import { createRulePlayer } from '../src/players.mjs';
import { lanAddresses, startTableServer } from '../src/server.mjs';
import { createTable } from '../src/table-session.mjs';

const FAST = 30;
const PLAYER_TYPES = Object.freeze([
  { id: 'human', name: 'You', category: 'human', available: true },
  { id: 'rule', name: 'Bot', category: 'bot', available: true },
  { id: 'agent', name: 'Open seat', category: 'agent', available: true, style_notes: true },
  { id: 'friend', name: 'Friend', category: 'friend', available: true }
]);

function openTable(overrides = {}) {
  return createTable({
    playerTypes: PLAYER_TYPES,
    createPlayer: (type, context) => createRulePlayer({ name: 'Bot', random: seededRandom(context.seed + context.seat), iterations: FAST }),
    hands: 3,
    seed: 17,
    botDelayMs: 0,
    turnLimitMs: 0,
    ...overrides
  });
}

// Change notices plus a short poll: an open seat's turn starts without a notice, as outside agents poll for it.
function until(table, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error('the table did not reach the expected state'));
    }, timeoutMs);
    const check = () => {
      const state = table.snapshot();
      if (state.status === 'error') {
        stop();
        reject(new Error(state.error.message));
        return;
      }
      if (!predicate(state)) return;
      stop();
      resolve(state);
    };
    const unsubscribe = table.subscribe(check);
    const poll = setInterval(check, 50);
    check();
  });
}

const safeMove = labels => (labels.includes('check') ? 'check' : labels.includes('call') ? 'call' : 'fold');

test('a friend sees the table from their own seat: their cards only, turned to seat 0, and plays only through their key', async () => {
  const table = openTable({ playerTypes: [...PLAYER_TYPES, { id: 'secret', name: 'Model', category: 'agent', available: false, unavailable_reason: 'host account detail', models: ['private-model'], style_notes: true }] });
  await table.newGame({ players: ['human', { type: 'friend', name: 'Mai' }, { type: 'agent', style_note: 'press the friend in seat 1' }] });
  assert.equal(table.snapshot().players[1].name, 'Mai');
  // Nothing in a friend's view is the host's alone: not the deck's seed, notes to other seats, or account details.
  const first = table.guestSnapshot(1);
  assert.notEqual(first.seed, table.snapshot().seed);
  assert.equal(first.seed, 1, 'games are numbered instead');
  assert.ok(first.players.every(player => player.style_note === null));
  assert.deepEqual(first.warnings, []);
  // Player types not seated at this table, and anything about the host's tools, are left out entirely.
  assert.equal(first.player_types.some(type => type.id === 'secret'), false);
  assert.ok(first.player_types.every(type => type.unavailable_reason === null && type.models === null));
  assert.equal(JSON.stringify(first).includes('private-model') || JSON.stringify(first).includes('press the friend'), false);
  assert.equal(table.seatForKey(table.seatKey(1)), 1);
  assert.equal(table.seatForKey('not-a-key'), null);
  assert.throws(() => table.guestSnapshot(2), error => error.code === 'SEAT_NOT_FRIEND');

  // Play the hand out: the person checks or calls, the friend too, through their own route.
  let sawFriendTurn = false;
  for (let step = 0; step < 60; step += 1) {
    const state = await until(table, view => ['your_turn', 'hand_over'].includes(view.status) || table.guestSnapshot(1).status === 'your_turn' || table.seatView(2).status === 'your_turn');
    if (state.status === 'hand_over') break;
    const open = table.seatView(2);
    if (open.status === 'your_turn') {
      table.seatAct(2, safeMove(open.legal_actions.map(action => action.label)));
      continue;
    }
    const friend = table.guestSnapshot(1);
    if (friend.status === 'your_turn') {
      sawFriendTurn = true;
      // Turned round: the friend is seat 0, the open seat 1, the person who runs the table seat 2.
      assert.deepEqual(friend.players.map(player => [player.seat, player.name]), [[0, 'Mai'], [1, 'Open seat'], [2, 'Host']], 'the person running the table is the Host on a friend\'s page');
      assert.equal(friend.guest.seat, 1);
      assert.ok(friend.hand.cards[0], 'the friend sees their own cards');
      assert.deepEqual([friend.hand.cards[1], friend.hand.cards[2]], [null, null], 'and no one else\'s');
      assert.equal(table.snapshot().hand.cards[1], null, 'the person running the table does not see the friend\'s cards');
      assert.throws(() => table.friendAct(1, 'not_a_move'), error => error.code === 'ILLEGAL_ACTION');
      assert.throws(() => table.seatAct(1, 'fold'), error => error.code === 'SEAT_NOT_OPEN', 'the open-seat protocol cannot play a friend\'s seat');
      table.friendAct(1, safeMove(friend.hand.legal_actions.map(action => action.label)));
      assert.throws(() => table.friendAct(1, 'fold'), error => error.code === 'NOT_YOUR_TURN');
      continue;
    }
    if (state.status === 'your_turn') {
      table.act(safeMove(state.hand.legal_actions.map(action => action.label)));
      continue;
    }
  }
  assert.ok(sawFriendTurn);
  const over = table.guestSnapshot(1);
  assert.equal(over.status, 'hand_over');
  const host = table.snapshot();
  // The same chips, seen from the friend's side.
  assert.deepEqual(over.hand.stacks, [host.hand.stacks[1], host.hand.stacks[2], host.hand.stacks[0]]);
  assert.deepEqual(over.totals.net, [host.totals.net[1], host.totals.net[2], host.totals.net[0]]);
  for (const list of over.hand.decisions.filter(Array.isArray)) for (const decision of list) assert.equal('hand_strength' in decision, false, 'no reasoning that hints at a hidden hand');
  assert.equal(over.hand.decisions[0], null, 'a friend\'s own moves carry no recap');
  table.stop();
});

test('with --lan another computer may only open the friend page and its own seat', async (t) => {
  const [ip] = lanAddresses();
  if (!ip) {
    t.skip('this computer has no home-network address');
    return;
  }
  const table = openTable();
  await table.newGame({ players: [{ type: 'friend', name: 'Ann' }, 'rule'] });
  const server = await startTableServer({ table, port: 0, lan: true });
  const remote = `http://${ip}:${server.port}`;
  try {
    // Asked through the network address, the request comes from a non-loopback address.
    assert.equal((await fetch(`${remote}/state`)).status, 403);
    assert.equal((await fetch(`${remote}/`)).status, 403);
    assert.equal((await fetch(`${remote}/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${remote}/seats/0/view`)).status, 403);
    assert.equal((await fetch(`${remote}/play`)).status, 200);
    assert.equal((await fetch(`${remote}/guest/state`)).status, 401);
    assert.equal((await fetch(`${remote}/guest/state`, { headers: { 'X-Seat-Key': 'wrong' } })).status, 401);
    const mine = await fetch(`${remote}/guest/state`, { headers: { 'X-Seat-Key': table.seatKey(0) } });
    assert.equal(mine.status, 200);
    assert.equal((await mine.json()).guest.name, 'Ann');
    // This computer still runs everything, and gets the friends' links.
    const local = `http://127.0.0.1:${server.port}`;
    const state = await (await fetch(`${local}/state`)).json();
    assert.equal(state.lan.enabled, true);
    const invites = await (await fetch(`${local}/invites`)).json();
    assert.deepEqual(invites.links.map(link => [link.seat, link.name]), [[0, 'Ann']]);
    assert.equal(invites.links[0].url, `http://${ip}:${server.port}/play#key=${table.seatKey(0)}`);
  } finally {
    await server.close();
  }
});

test('without --lan the table answers this computer only', async (t) => {
  const [ip] = lanAddresses();
  if (!ip) {
    t.skip('this computer has no home-network address');
    return;
  }
  const table = openTable();
  const server = await startTableServer({ table, port: 0 });
  try {
    await assert.rejects(fetch(`http://${ip}:${server.port}/play`));
    assert.equal((await (await fetch(`http://127.0.0.1:${server.port}/state`)).json()).lan.enabled, false);
  } finally {
    await server.close();
  }
});

test('the history shows a friend\'s cards only at a showdown', async () => {
  const match = await playMatch({
    players: [createRulePlayer({ random: seededRandom(1), iterations: FAST }), createRulePlayer({ random: seededRandom(2), iterations: FAST, style: 'loose_passive' })],
    hands: 12,
    resetStacks: true,
    random: seededRandom(3)
  });
  // `seats` after the match result, which has its own seat count under that name.
  const report = { run_id: '2026-10-01T12-00-00-000Z-000000cc', created_at: '2026-10-01T12:00:00.000Z', mode: 'web', blinds: { small: 1, big: 2 }, ...match, seats: [{ type: 'rule' }, { type: 'friend' }] };
  const detail = gameDetail(report);
  assert.equal(detail.spectator, true);
  for (const [index, hand] of detail.hands.entries()) {
    const raw = match.log[index];
    const folded = raw.actions.some(action => action.seat === 1 && action.label === 'fold');
    const shownDown = raw.result.reason === 'showdown' && !folded;
    assert.deepEqual(hand.cards[1], shownDown ? raw.hole_cards[1] : null);
    assert.deepEqual(hand.cards[0], raw.hole_cards[0], 'a bot\'s cards were on show to the watching owner');
  }
});

test('with no seat for the host, a friend deals each next hand; with the host seated, only the host does', async () => {
  const table = openTable({ hands: 2 });
  const server = await startTableServer({ table, port: 0 });
  try {
    await table.newGame({ players: [{ type: 'friend', name: 'Ann' }, 'rule'] });
    const key = table.seatKey(0);
    assert.equal(table.guestSnapshot(0).guest.can_deal, true, 'the host has no seat here');
    // Ann plays the hand out, then deals the next one from her own link.
    const over = await until(table, state => {
      if (state.status === 'hand_over') return true;
      const own = table.guestSnapshot(0);
      if (own.status === 'your_turn') table.friendAct(0, safeMove(own.hand.legal_actions.map(action => action.label)));
      return false;
    });
    assert.equal(over.hand.number, 1);
    const dealt = await fetch(`${server.url}/guest/next`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seat-Key': key }, body: '{}' });
    assert.equal(dealt.status, 200);
    await until(table, state => state.hand?.number === 2);
    // A second press, once the hand is already dealt, changes nothing and is not an error.
    assert.equal(table.friendNext(0).guest.can_deal, true);
    assert.equal(table.snapshot().hand.number, 2);
    assert.equal((await fetch(`${server.url}/guest/next`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seat-Key': 'wrong' }, body: '{}' })).status, 401);

    // With the host seated, the host deals: a friend's request is refused.
    await table.newGame({ players: ['human', { type: 'friend', name: 'Ann' }] });
    assert.equal(table.guestSnapshot(1).guest.can_deal, false);
    const refused = await fetch(`${server.url}/guest/next`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seat-Key': table.seatKey(1) }, body: '{}' });
    assert.deepEqual([refused.status, (await refused.json()).code], [403, 'HOST_DEALS']);
  } finally {
    table.stop();
    await server.close();
  }
});
