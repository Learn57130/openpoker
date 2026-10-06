import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SYSTEM_PROMPT = 'You choose one action in a poker game. Answer with only the action label. Do not use tools.';
const MAX_OUTPUT_BYTES = 256 * 1024;

export const AGENT_CLIS = Object.freeze({
  claude: { name: 'Claude', binary: 'claude', sign_in_hint: 'Run `claude` in a terminal and sign in.' },
  codex: { name: 'Codex', binary: 'codex', sign_in_hint: 'Run `codex` in a terminal, sign in, and pick a model your account supports.' },
  opencode: { name: 'OpenCode', binary: 'opencode', sign_in_hint: 'Pick a model your OpenCode account can use, for example one listed by `opencode models`.' }
});

function cliError(message, code = 'AGENT_CLI_ERROR') {
  return Object.assign(new Error(String(message).replace(/\s+/g, ' ').trim().slice(0, 240)), { code });
}

/** Whether the command-line tool is installed. It does not check that the tool is signed in. */
export function inspectAgentCli(kind) {
  const cli = AGENT_CLIS[kind];
  if (!cli) throw new TypeError(`Unknown agent CLI: ${kind}`);
  const probe = spawnSync(cli.binary, ['--version'], { encoding: 'utf8', timeout: 8000, shell: false });
  const available = !probe.error && probe.status === 0;
  return { available, version: available ? probe.stdout.trim().split('\n')[0] : null, unavailable_reason: available ? null : `the \`${cli.binary}\` command was not found` };
}

// Models the local OpenCode tool offers, as `provider/model` names. Empty when the tool cannot list them.
export function listOpencodeModels({ limit = 200 } = {}) {
  const listed = spawnSync('opencode', ['models'], { encoding: 'utf8', timeout: 10_000, shell: false });
  if (listed.error || listed.status !== 0) return [];
  return listed.stdout.split('\n').map(line => line.trim()).filter(line => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(line)).slice(0, limit);
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function run(binary, args, { input, cwd, timeoutMs, spawnFn, signal, env }) {
  return new Promise((resolve, reject) => {
    // The turn is already over: do not start the tool at all.
    if (signal?.aborted) {
      reject(cliError(`${binary} was not started because the turn ran out of time`, 'AGENT_CLI_ABORTED'));
      return;
    }
    const child = spawnFn(binary, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(cliError(`${binary} did not answer within ${Math.round(timeoutMs / 1000)} seconds`, 'AGENT_CLI_TIMEOUT'));
    }, timeoutMs);
    // The turn's clock ran out: stop the tool so its answer is not computed for nothing.
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(cliError(`${binary} was stopped because the turn ran out of time`, 'AGENT_CLI_ABORTED'));
    }, { once: true });
    child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(cliError(`${binary} could not be started: ${error.message}`));
    });
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/**
 * Returns `ask(prompt) -> { text, model }` backed by a local Claude Code, Codex or OpenCode command-line session.
 * Each question starts a fresh session in an empty directory with no tools (Claude), a read-only sandbox
 * (Codex) or the read-only plan agent (OpenCode). It uses the account the tool is signed in with; no key
 * is read or stored by this project. With `reasoning: false` the tool is asked to answer without thinking
 * first (Claude: a zero thinking budget; Codex: low reasoning effort; OpenCode: the `minimal` variant).
 */
export function createAgentCliAsk({ kind, model, reasoning = true, timeoutMs = 90_000, spawnFn = spawn } = {}) {
  const cli = AGENT_CLIS[kind];
  if (!cli) throw new TypeError(`Unknown agent CLI: ${kind}`);
  let workDir = null;
  return async function ask(prompt, { signal } = {}) {
    workDir ||= await fs.mkdtemp(path.join(os.tmpdir(), `jev-poker-${kind}-`));
    if (kind === 'claude') {
      const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--system-prompt', SYSTEM_PROMPT];
      if (model) args.push('--model', model);
      // Reasoning off: Claude Code answers directly when its thinking budget is zero.
      const env = reasoning ? undefined : { ...process.env, MAX_THINKING_TOKENS: '0' };
      const { stdout, stderr } = await run(cli.binary, args, { input: prompt, cwd: workDir, timeoutMs, spawnFn, signal, env });
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw cliError(`Claude returned no usable answer. ${stderr || stdout}`);
      }
      if (parsed.is_error) throw cliError(`${parsed.result || 'Claude reported an error'}. ${cli.sign_in_hint}`);
      // `modelUsage` is keyed by the model that really answered, whatever alias was asked for.
      return { text: String(parsed.result ?? ''), model: Object.keys(parsed.modelUsage || {})[0] ?? model ?? null };
    }
    if (kind === 'opencode') {
      // The read-only `plan` agent in an empty directory: it can answer but has nothing to change.
      const args = ['run', '--pure', '--dir', workDir, '--agent', 'plan'];
      if (model) args.push('-m', model);
      if (!reasoning) args.push('--variant', 'minimal');
      args.push(`${SYSTEM_PROMPT}\n\n${prompt}`);
      const { status, stdout, stderr } = await run(cli.binary, args, { cwd: workDir, timeoutMs, spawnFn, signal });
      const answer = stripAnsi(stdout).trim();
      if (status !== 0 || !answer) {
        const problem = stripAnsi(stderr).split('\n').map(line => line.trim()).filter(line => /error/i.test(line)).pop();
        throw cliError(`${(problem || `OpenCode exited with status ${status}`).replace(/^Error:\s*/i, '')}. ${cli.sign_in_hint}`);
      }
      return { text: answer, model: model ?? null };
    }
    const outputFile = path.join(workDir, `answer-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`);
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '-C', workDir, '-o', outputFile];
    if (model) args.push('-m', model);
    // Reasoning off: Codex has no zero setting, so ask for its lowest documented effort.
    if (!reasoning) args.push('-c', 'model_reasoning_effort="low"');
    args.push(`${SYSTEM_PROMPT}\n\n${prompt}`);
    const { status, stdout, stderr } = await run(cli.binary, args, { cwd: workDir, timeoutMs, spawnFn, signal });
    const answer = await fs.readFile(outputFile, 'utf8').catch(() => '');
    await fs.unlink(outputFile).catch(() => {});
    if (status !== 0 || !answer.trim()) {
      const problem = `${stdout}\n${stderr}`.split('\n').filter(line => /error/i.test(line)).pop();
      let message = problem || `Codex exited with status ${status}`;
      try {
        message = JSON.parse(problem.replace(/^ERROR:\s*/, '')).error.message;
      } catch {
        // Keep the raw line when it is not the JSON error shape.
      }
      throw cliError(`${message}. ${cli.sign_in_hint}`);
    }
    return { text: answer, model: model ?? null };
  };
}
