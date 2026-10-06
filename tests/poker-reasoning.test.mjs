import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createAgentCliAsk } from '../src/agent-cli.mjs';
import { createRulePlayer } from '../src/players.mjs';
import { createTable } from '../src/table-session.mjs';

// A stand-in for the tool: records how it was started and answers at once.
function fakeCli(reply) {
  const calls = [];
  const spawnFn = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on() {}, end() {} };
    child.kill = () => {};
    calls.push({ binary, args, options });
    setImmediate(async () => {
      const result = await reply({ binary, args, options });
      if (result.stdout) child.stdout.emit('data', result.stdout);
      child.emit('close', result.status ?? 0);
    });
    return child;
  };
  return { calls, spawnFn };
}

test('reasoning off starts Claude with a zero thinking budget and leaves it alone otherwise', async () => {
  const cli = fakeCli(() => ({ stdout: JSON.stringify({ is_error: false, result: 'call', modelUsage: { 'claude-test': {} } }) }));
  await createAgentCliAsk({ kind: 'claude', spawnFn: cli.spawnFn })('pick');
  assert.equal(cli.calls[0].options.env, undefined, 'reasoning on inherits the environment untouched');
  await createAgentCliAsk({ kind: 'claude', reasoning: false, spawnFn: cli.spawnFn })('pick');
  assert.equal(cli.calls[1].options.env.MAX_THINKING_TOKENS, '0');
  assert.equal(cli.calls[1].options.env.PATH, process.env.PATH, 'the rest of the environment is kept');
  assert.deepEqual(cli.calls[1].args, cli.calls[0].args, 'the command line is the same either way');
  assert.equal(cli.calls[1].options.shell, false);
});

test('reasoning off asks Codex for low effort and only then', async () => {
  const fs = await import('node:fs/promises');
  const cli = fakeCli(async ({ args }) => {
    await fs.writeFile(args[args.indexOf('-o') + 1], 'fold\n');
    return { status: 0 };
  });
  await createAgentCliAsk({ kind: 'codex', spawnFn: cli.spawnFn })('pick');
  assert.ok(!cli.calls[0].args.includes('-c'));
  const answer = await createAgentCliAsk({ kind: 'codex', reasoning: false, spawnFn: cli.spawnFn })('pick');
  assert.equal(answer.text.trim(), 'fold');
  const args = cli.calls[1].args;
  assert.equal(args[args.indexOf('-c') + 1], 'model_reasoning_effort="low"');
  assert.equal(args.at(-1).endsWith('pick'), true, 'the prompt stays the last argument');
  for (const call of cli.calls) await fs.rm(call.options.cwd, { recursive: true, force: true });
});

test('the table takes a reasoning switch only for seats that have one and passes it to the player', async () => {
  const built = [];
  const table = createTable({
    playerTypes: [
      { id: 'human', name: 'You', category: 'human', available: true },
      { id: 'rule', name: 'Bot', category: 'bot', available: true },
      { id: 'claude', name: 'Claude', category: 'agent', available: true, models: ['haiku'], reasoning: true }
    ],
    createPlayer: async (type, context) => {
      built.push({ type, reasoning: context.reasoning, model: context.model });
      return createRulePlayer({ name: type, iterations: 20 });
    },
    hands: 1,
    seed: 3,
    botDelayMs: 0
  });
  try {
    const state = await table.newGame({ players: ['human', { type: 'claude', model: 'haiku', reasoning: false }, { type: 'claude', model: 'haiku' }, 'rule'] });
    assert.deepEqual(state.players.map(player => [player.name, player.reasoning]), [['You', null], ['Claude · haiku · fast', false], ['Claude · haiku', true], ['Bot', null]]);
    assert.deepEqual(built, [{ type: 'claude', reasoning: false, model: 'haiku' }, { type: 'claude', reasoning: true, model: 'haiku' }, { type: 'rule', reasoning: null, model: null }]);
    assert.deepEqual(state.player_types.map(type => type.reasoning), [false, false, true]);
    await assert.rejects(() => table.newGame({ players: ['human', { type: 'rule', reasoning: false }] }), /does not have a reasoning switch/);
    await assert.rejects(() => table.newGame({ players: ['human', { type: 'claude', reasoning: 'off' }] }), /true or false/);
    await assert.rejects(() => table.newGame({ players: ['human', { type: 'claude', model: '--help' }] }), /starting with a letter or digit/);
    assert.equal(table.snapshot().players.length, 4, 'a refused request leaves the running game in place');
    // Dealing the same table again keeps each seat's switch.
    built.length = 0;
    const again = await table.newGame();
    assert.deepEqual(again.players.map(player => player.reasoning), [null, false, true, null]);
    assert.deepEqual(built.map(entry => entry.reasoning), [false, true, null]);
  } finally {
    table.stop();
  }
});
