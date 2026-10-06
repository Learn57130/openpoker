import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const QUICK_ADDRESS = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const MAX_KEPT_OUTPUT = 16 * 1024;

// The last line cloudflared marked as an error, for a message the owner can act on.
function lastError(output) {
  const lines = output.split('\n').filter(line => /\bERR\b|error/i.test(line));
  return lines.at(-1)?.replace(/^\S+\s+ERR\s+/, '').trim().slice(0, 200) || null;
}

/**
 * Opens a Cloudflare quick tunnel (no account) to `http://127.0.0.1:<port>` and returns at once.
 * `ready` resolves with the public `https://….trycloudflare.com` address, or rejects with why there is
 * none; `status()` reports `starting`, `open`, `failed` or `closed`. cloudflared reads a temporary config
 * holding only `no-autoupdate: true`, so the owner's own `~/.cloudflared/config.yml` (a named tunnel for
 * another project) is neither read nor changed. A tunnel that drops is not restarted: a new one would
 * get a new address, and every link already sent would stop working anyway.
 */
export function startQuickTunnel({ port, binary = 'cloudflared', spawnFn = spawn, timeoutMs = 60_000 } = {}) {
  const state = { state: 'starting', url: null, hostname: null, reason: null };
  let child = null;
  let configDir = null;
  // Rejects `ready` when the table stops before the tunnel opened.
  let abandon = null;
  const cleanUp = () => {
    if (configDir) fs.rm(configDir, { recursive: true, force: true }).catch(() => {});
    configDir = null;
  };
  const ready = (async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-poker-tunnel-'));
    const config = path.join(configDir, 'cloudflared.yml');
    await fs.writeFile(config, 'no-autoupdate: true\n', { mode: 0o600 });
    const stopped = () => Object.assign(new Error('The tunnel was stopped before it opened'), { code: 'TUNNEL_STOPPED' });
    if (state.state === 'closed') {
      cleanUp();
      throw stopped();
    }
    return await new Promise((resolve, reject) => {
      let output = '';
      abandon = () => reject(stopped());
      const fail = reason => {
        if (state.state !== 'starting') return;
        Object.assign(state, { state: 'failed', reason });
        cleanUp();
        reject(Object.assign(new Error(reason), { code: 'TUNNEL_FAILED' }));
      };
      const timer = setTimeout(() => {
        fail(`cloudflared gave no address within ${Math.round(timeoutMs / 1000)} seconds`);
        child.kill('SIGTERM');
      }, timeoutMs);
      child = spawnFn(binary, ['tunnel', '--config', config, '--url', `http://127.0.0.1:${port}`], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      // cloudflared writes its log, the address included, to stderr; stdout is read too in case that changes.
      const read = chunk => {
        output = (output + chunk).slice(-MAX_KEPT_OUTPUT);
        const found = state.state === 'starting' ? QUICK_ADDRESS.exec(output) : null;
        if (!found) return;
        clearTimeout(timer);
        Object.assign(state, { state: 'open', url: found[0], hostname: new URL(found[0]).hostname });
        resolve({ url: state.url, hostname: state.hostname });
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.on('error', error => {
        clearTimeout(timer);
        fail(error.code === 'ENOENT' ? 'cloudflared is not installed (on a Mac: brew install cloudflared)' : `cloudflared could not be started: ${error.message}`);
      });
      child.on('close', status => {
        clearTimeout(timer);
        if (state.state === 'starting') fail(lastError(output) || `cloudflared stopped with status ${status}`);
        else if (state.state === 'open') {
          Object.assign(state, { state: 'closed', reason: lastError(output) || `cloudflared stopped with status ${status}` });
          cleanUp();
        }
      });
    });
  })();
  // A failure is reported through `ready` and `status()`; nobody has to await it.
  ready.catch(() => {});
  return {
    ready,
    status: () => ({ ...state }),
    /** Stops cloudflared. Safe to call more than once, and from a process `exit` handler. */
    stop() {
      if (state.state === 'starting' || state.state === 'open') Object.assign(state, { state: 'closed', reason: 'the table stopped' });
      if (child && child.exitCode == null && !child.killed) child.kill('SIGTERM');
      abandon?.();
      cleanUp();
    }
  };
}
