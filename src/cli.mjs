import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, DEFAULT_OUTPUT_DIR } from './lib/constants.mjs';
import { createJevKeyStore } from './jev-key.mjs';
import { makeRunId } from './lib/files.mjs';
import { AttemptBudget, TypeSafeClient } from './lib/typesafe-client.mjs';
import { AGENT_CLIS, createAgentCliAsk, inspectAgentCli, listOpencodeModels } from './agent-cli.mjs';
import { seededRandom } from './cards.mjs';
import { POKER_POLICY_VERSION, POKER_QUESTION_VERSION } from './constants.mjs';
import { runPokerDecision } from './poker-decision.mjs';
import { createGameHistory } from './game-history.mjs';
import { writePokerLog } from './log.mjs';
import { MATCH_LIMITS, playMatch } from './match.mjs';
import { createPersonaStore } from './persona-store.mjs';
import { createJevPlayer, createModelPlayer, createRulePlayer } from './players.mjs';
import { lanAddresses, startGuestServer, startTableServer } from './server.mjs';
import { startQuickTunnel } from './tunnel.mjs';
import { createTable } from './table-session.mjs';
import { createTerminalGame } from './terminal.mjs';

// An optional add-on, kept out of this repository in addons/learner/ (Git ignores it). When it is there
// the game loads it: an extra bot seat, its own commands and its own part of the page. Without it the
// game plays as usual. OPENPOKER_ADDONS=off ignores it.
const LEARNER_ADDON = new URL('../addons/learner/index.mjs', import.meta.url);
const learner = process.env.OPENPOKER_ADDONS === 'off' ? null : await fs.access(fileURLToPath(LEARNER_ADDON)).then(() => import(LEARNER_ADDON.href), () => null);

// Players an add-on adds (id, aliases, a default-model option, its type, how to ask it, a doctor line).
const EXTRA_PLAYERS = Array.isArray(learner?.EXTRA_PLAYERS) ? learner.EXTRA_PLAYERS : [];
// An add-on's edition may keep its data and key file in its own folder; --output-dir and --env-file still win.
const EDITION_DATA_DIR = typeof learner?.DATA_DIR === 'string' ? learner.DATA_DIR : null;
const EDITION_ENV_FILE = typeof learner?.ENV_FILE === 'string' ? learner.ENV_FILE : null;
function editionDefaults(options) {
  if (options.output_dir === undefined && EDITION_DATA_DIR) options.output_dir = EDITION_DATA_DIR;
  if (options.env_file === undefined && EDITION_ENV_FILE) options.env_file = EDITION_ENV_FILE;
  return options;
}
const extraPlayer = id => EXTRA_PLAYERS.find(player => player.id === id) ?? null;
const optionKey = option => option.slice(2).replaceAll('-', '_');

export const POKER_USAGE = `  openpoker doctor [--port N] [--format json]
  openpoker [--opponent rule|jev${learner ? '|learner] [--policy NAME' : ''}] [--hands N] [--stack N] [--blinds SB/BB] [--seed N] [--auto] [--show-decisions]
  openpoker --web [--port N] [--lan] [--tunnel] [--players SEAT0,SEAT1,...] [--hands N] [--stack N] [--blinds SB/BB] [--turn-limit SECONDS]${learner ? `\n${learner.LEARNER_USAGE}` : ''}`;

export const POKER_OPTION_USAGE = `  --opponent NAME       Poker opponent: rule (no API key needed) or jev${learner ? ', or learner' : ''}; with --web also claude, codex, opencode${EXTRA_PLAYERS.map(player => `, ${player.id}`).join('')} or agent${learner ? `\n${learner.LEARNER_OPTION_USAGE}` : ''}
  --players A,B,...     Poker --web seats, two to six, your seat first: you, jev, claude, codex, opencode, ${EXTRA_PLAYERS.map(player => `${player.id}${player.aliases?.length ? ` (or ${player.aliases.join(', ')})` : ''}, `).join('')}bot, ${learner ? 'learner, ' : ''}agent, friend; add :MODEL for a model, @fast to turn reasoning off, +STYLE for a playing style (tight_aggressive, loose_aggressive, tight_passive, loose_passive), e.g. you,jev+tight_passive,claude:sonnet@fast,bot (default: choose on the start screen)
  --stack N             Poker starting chips (default 10000; 200 with --auto)
  --blinds SB/BB        Poker blinds (default 50/100; 1/2 with --auto)
  --turn-limit SECONDS  Poker --web: time allowed for each decision, 0 for no limit (default 30, the standard shot clock)
  --claude-model NAME   Poker --web: model for the Claude player (default: the Claude CLI's own default)
  --codex-model NAME    Poker --web: model for the Codex player (default: the Codex CLI's own default)
  --opencode-model NAME Poker --web: provider/model for the OpenCode player (default opencode/big-pickle)${EXTRA_PLAYERS.map(player => `\n${player.optionUsage}`).join('')}
  --auto                Poker: play the opponent against the rule bot with mirrored deals and print a report
  --show-decisions      Poker: after each hand, show what the bot chose and how confident Jev was
  --web                 Poker: serve a card table at http://127.0.0.1:PORT instead of the terminal game
  --port N              Poker --web port (default 8787)
  --lan                 Poker --web: also listen on the home network, so friends on the same Wi-Fi can take Friend seats from their own devices
  --tunnel              Poker --web: open a Cloudflare quick tunnel (cloudflared, no account) so friends on any network can take Friend seats with their links`;

const USAGE = `OpenPoker: Texas Hold'em for two to six seats, with play chips only, where people, bots and AI agents play each other.

Usage:
${POKER_USAGE}

Options:
${POKER_OPTION_USAGE}
  --output-dir DIR      Where saved games and personas live (default ~/.openpoker, or OPENPOKER_HOME)
  --env-file FILE       File holding TYPESAFE_API_KEY for the optional Jev player (default .env in the current folder)
  --format json         Print machine-readable output
`;

function usageError(message) {
  return Object.assign(new Error(`${message}\n\n${USAGE}`), { code: 'USAGE' });
}

function parseOptions(args, valued, flags, repeatable = new Set()) {
  const options = {};
  const operands = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valued.has(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw usageError(`${arg} requires a value`);
      const key = arg.slice(2).replaceAll('-', '_');
      if (repeatable.has(arg)) options[key] = [...(options[key] || []), value];
      else options[key] = value;
    } else if (flags.has(arg)) {
      options[arg.slice(2).replaceAll('-', '_')] = true;
    } else if (arg.startsWith('--')) {
      throw usageError(`Unknown option: ${arg}`);
    } else {
      operands.push(arg);
    }
  }
  return { options, operands };
}

function integerOption(raw, fallback, name, max) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw usageError(`${name} must be an integer from 1 to ${max}`);
  return value;
}

function print(value, format = 'human') {
  if (format === 'json') console.log(JSON.stringify(value));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Jev-only statistics for the seat it played. Forced moves (one legal action) never reach Jev.
function jevDecisionStats(match, seat) {
  const sources = match.players[seat].decision_sources;
  const asked = sources.jev + sources.fallback;
  const metas = match.log.flatMap(hand => hand.actions.filter(action => action.seat === seat && action.meta).map(action => action.meta));
  const tokens = metas.map(meta => meta.input_tokens).filter(Number.isFinite);
  return {
    asked,
    played_by_jev: sources.jev,
    rule_bot_stepped_in: sources.fallback,
    abstention_rate: asked ? Number((sources.fallback / asked).toFixed(3)) : null,
    stepped_in_by_reason: sources.by_reason,
    agreement_with_rule_bot: sources.jev ? Number((sources.agrees_with_rule / sources.jev).toFixed(3)) : null,
    median_latency_ms: median(metas.map(meta => meta.latency_ms).filter(Number.isFinite)),
    input_tokens: tokens.reduce((total, value) => total + value, 0)
  };
}

// The Jev bot gets its own client so its attempt budget covers one match.
async function createPokerBot(opponent, { hands, model, keys, outputDir, random, style, policy, learn = false }) {
  // The add-on's bot; `learn` asks it to keep what this game shows.
  if (opponent === 'learner') return await learner.createLearnerBot({ outputDir, random, policy, learn });
  if (opponent !== 'jev') return createRulePlayer({ name: 'Rule bot', random, style });
  const client = new TypeSafeClient({
    apiKey: await keys.get(),
    model,
    requestTimeoutMs: 20_000,
    // Two attempts per decision at most; a hand rarely needs more than six Jev decisions.
    attemptBudget: new AttemptBudget(hands * 12)
  });
  return createJevPlayer({ name: 'Jev', decide: input => runPokerDecision({ input, client }), random, style });
}

function pokerReport(match, { mode, opponent, seed, model, startedAt }) {
  return {
    schema_version: 'jev/poker-match/v1',
    status: 'complete',
    run_id: makeRunId(),
    created_at: new Date().toISOString(),
    mode,
    opponent,
    seed,
    ...(opponent === 'jev' ? { model, question_version: POKER_QUESTION_VERSION, policy_version: POKER_POLICY_VERSION, jev: jevDecisionStats(match, 1) } : {}),
    duration_ms: Date.now() - startedAt,
    ...match
  };
}

const DEFAULT_OPENCODE_MODEL = 'opencode/big-pickle';
const WEB_PLAYER_IDS = Object.freeze(['human', 'jev', 'claude', 'codex', 'opencode', ...EXTRA_PLAYERS.map(player => player.id), 'rule', ...(learner ? ['learner'] : []), 'friend', 'agent']);

function turnLimitSeconds(raw) {
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 600) throw usageError('--turn-limit must be 0 (no limit) to 600 seconds');
  return seconds;
}

function parseWebPlayers(options, opponent) {
  if (options.players === undefined) return ['human', opponent];
  const players = options.players.split(',').map(value => {
    // `TYPE[:MODEL][@fast][+STYLE]`. Split at the first colon only: a model name may itself contain colons.
    const [seatSpec, style] = value.trim().split('+');
    const fast = /@(fast|off)$/i.test(seatSpec);
    const [name, ...rest] = seatSpec.replace(/@(fast|off)$/i, '').split(':');
    const model = rest.join(':');
    const aliases = { you: 'human', me: 'human', bot: 'rule', ...Object.fromEntries(EXTRA_PLAYERS.flatMap(player => (player.aliases ?? []).map(alias => [alias, player.id]))) };
    const type = aliases[name.toLowerCase()] || name.toLowerCase();
    if (!model && !fast && !style) return type;
    return { type, ...(model ? { model } : {}), ...(fast ? { reasoning: false } : {}), ...(style ? { style: style.toLowerCase().replaceAll('-', '_') } : {}) };
  });
  const typeOf = player => (typeof player === 'string' ? player : player.type);
  if (players.length < 2 || players.length > 6 || players.some(player => !WEB_PLAYER_IDS.includes(typeOf(player)))) {
    throw usageError(`--players needs two to six of: you, ${WEB_PLAYER_IDS.slice(1).join(', ')} (your seat first), for example --players you,jev,bot,claude:sonnet`);
  }
  if (players.slice(1).some(player => typeOf(player) === 'human')) throw usageError('--players: you can only sit in the first seat, so list yourself first');
  return players;
}

// "50/100" -> { smallBlind: 50, bigBlind: 100 }
function parseBlinds(raw, fallback) {
  if (raw === undefined) return fallback;
  const match = /^(\d{1,7})\/(\d{1,7})$/.exec(raw);
  const smallBlind = Number(match?.[1]);
  const bigBlind = Number(match?.[2]);
  if (!match || smallBlind < 1 || bigBlind < smallBlind) throw usageError('--blinds needs SMALL/BIG with BIG at least as large as SMALL, for example --blinds 50/100');
  return { smallBlind, bigBlind };
}

async function pokerWebCommand({ options, opponent, hands, stack, blinds, model, outputDir }) {
  const port = options.port === undefined ? 8787 : Number(options.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw usageError('--port must be an integer from 0 to 65535');
  const players = parseWebPlayers(options, opponent);
  // Jev's key: from the environment or a .env file, or typed on the start screen while the table runs.
  const keys = createJevKeyStore({ envFile: options.env_file, dataDir: outputDir });
  let jevReady = await keys.has();
  if (players.some(player => (player.type || player) === 'jev') && !jevReady) await keys.get();
  const clis = { claude: inspectAgentCli('claude'), codex: inspectAgentCli('codex'), opencode: inspectAgentCli('opencode') };
  const opencodeModels = clis.opencode.available ? listOpencodeModels() : [];
  // With the add-on: its seats, what it does with finished games, and its saved policies.
  const learning = learner ? learner.createTableLearning({ outputDir }) : null;
  const policies = learner ? await learner.listPolicies(outputDir) : [];
  const started = new Map();
  const table = createTable({
    // An add-on's edition may carry its own name.
    brand: learner?.BRAND ?? 'OpenPoker',
    playerTypes: [
      { id: 'human', name: 'You', category: 'human', available: true },
      { id: 'jev', name: 'Jev', category: 'agent', models: ['jev-latest', 'jev-preview', 'jev-1.13.0'], styles: true, get available() { return jevReady; }, get unavailable_reason() { return jevReady ? null : 'it needs a TypeSafe API key; add one in the Jev key box below'; } },
      // Aliases named in `claude --help`, plus haiku, which the CLI also accepts. Any full model name works too.
      { id: 'claude', name: 'Claude', category: 'agent', models: ['fable', 'opus', 'sonnet', 'haiku'], reasoning: true, styles: true, style_notes: true, slow: true, available: clis.claude.available, unavailable_reason: clis.claude.unavailable_reason },
      // Codex model names depend on the account, so none is suggested.
      { id: 'codex', name: 'Codex', category: 'agent', models: [], reasoning: true, styles: true, style_notes: true, slow: true, available: clis.codex.available, unavailable_reason: clis.codex.unavailable_reason },
      // OpenCode names models as provider/model; the suggestions come from `opencode models`.
      { id: 'opencode', name: 'OpenCode', category: 'agent', models: opencodeModels, reasoning: true, styles: true, style_notes: true, slow: true, available: clis.opencode.available, unavailable_reason: clis.opencode.unavailable_reason },
      ...EXTRA_PLAYERS.map(player => player.describe()),
      { id: 'rule', name: 'Bot', category: 'bot', styles: true, available: true },
      ...(learner ? [learner.playerType(policies)] : []),
      { id: 'agent', name: 'Open seat', category: 'agent', styles: true, style_notes: true, available: true },
      // A person on the home network, playing from their own seat link.
      { id: 'friend', name: 'Friend', category: 'friend', available: Boolean(options.lan || options.tunnel), unavailable_reason: options.lan || options.tunnel ? null : 'start the table with --lan (friends on your Wi-Fi) or --tunnel (friends anywhere)' }
    ],
    defaultPlayers: players,
    // Saved personas and their ratings live beside the hand logs, in a private file.
    personaStore: createPersonaStore({ file: path.join(path.resolve(outputDir), 'poker', 'personas.json') }),
    // The game history log reads the match logs this table writes.
    gameHistory: createGameHistory({ directory: path.join(path.resolve(outputDir), 'poker') }),
    // The add-on's dashboard data, when it is installed.
    learnerBoard: learner ? learner.createLearnerBoard({ directory: learner.policyDirectory(outputDir) }) : null,
    hands,
    stack,
    smallBlind: blinds.smallBlind,
    bigBlind: blinds.bigBlind,
    turnLimitMs: options.turn_limit === undefined ? 30_000 : turnLimitSeconds(options.turn_limit) * 1000,
    seed: options.seed === undefined ? undefined : integerOption(options.seed, 1, '--seed', 2 ** 31),
    createPlayer: async (type, context) => {
      started.set(context.seed, Date.now());
      const random = seededRandom(context.seed + 11 + context.seat);
      if (Object.hasOwn(AGENT_CLIS, type)) {
        // OpenCode's own default model may not be one the account can use, so a free one known to answer is the fallback.
        const flagModel = { claude: options.claude_model, codex: options.codex_model, opencode: options.opencode_model || DEFAULT_OPENCODE_MODEL }[type];
        const ask = createAgentCliAsk({ kind: type, model: context.model || flagModel, reasoning: context.reasoning !== false });
        return createModelPlayer({ name: AGENT_CLIS[type].name, kind: type, ask, random, style: context.style, styleNote: context.styleNote });
      }
      const extra = extraPlayer(type);
      if (extra) {
        const ask = extra.createAsk({ model: context.model || options[optionKey(extra.option)] || null, reasoning: context.reasoning !== false });
        return createModelPlayer({ name: extra.name, kind: type, ask, random, style: context.style, styleNote: context.styleNote });
      }
      if (type === 'learner') {
        const policy = context.model || (policies.includes(learner.DEFAULT_POLICY) || !policies.length ? learner.DEFAULT_POLICY : policies[0]);
        try {
          const player = await createPokerBot('learner', { outputDir, random, policy, learn: true });
          learning.track(context.seed, player);
          return player;
        } catch (error) {
          // A policy that is not there is a seat that cannot be filled, not a server fault.
          throw Object.assign(new Error(error.message), { code: error.code === 'POLICY_NOT_FOUND' ? 'PLAYER_UNAVAILABLE' : error.code });
        }
      }
      return await createPokerBot(type, { hands, model: context.model || model, keys, outputDir, random, style: context.style });
    },
    onMatchEnd: async (match, context) => {
      if (learning) {
        await learning.gameEnded(context.seed);
        // After the game's log is written (below), the add-on reads it.
        setImmediate(() => learning.learnFromGames());
      }
      if (!match.hands_played) return null;
      const opponentId = context.players.length === 2 ? context.players[1] : 'table';
      const report = pokerReport(match, { mode: 'web', opponent: opponentId, seed: context.seed, model, startedAt: started.get(context.seed) ?? Date.now() });
      return await writePokerLog({ ...report, seats: context.seats }, outputDir);
    }
  });
  // A tunnel reaches its own guest-only listener: cloudflared forwards from this computer, so the owner's port
  // would take every request from the internet for the owner's own.
  let guest = null;
  let tunnel = null;
  if (options.tunnel) {
    guest = await startGuestServer({ table });
    tunnel = startQuickTunnel({ port: guest.port });
    tunnel.ready.then(({ hostname }) => guest.allowHost(hostname), () => {});
    process.once('exit', () => tunnel.stop());
  }
  // The start screen's Jev key box. Every answer says only whether a key is set and where; never the key.
  const jevKey = {
    async refreshed(status) {
      if (status.set !== jevReady) {
        jevReady = status.set;
        table.playerTypesChanged();
      }
      return status;
    },
    async status() { return this.refreshed(await keys.status()); },
    async set(key, options) { return this.refreshed(await keys.set(key, options)); },
    async forget() { return this.refreshed(await keys.forget()); }
  };
  const server = await startTableServer({ table, port, lan: Boolean(options.lan), tunnel, pageExtras: learner?.PAGE_EXTRAS ?? '', jevKey });
  // Games the add-on has not read yet.
  learning?.learnFromGames();
  // Seats named on the command line start a game at once; otherwise the page asks for a mode first.
  if (options.players !== undefined || options.opponent !== undefined) await table.newGame();
  console.log(`Poker table: ${server.url.replace('0.0.0.0', '127.0.0.1')}`);
  if (options.lan) {
    const addresses = lanAddresses();
    console.log(addresses.length
      ? `Friends on your Wi-Fi can join at ${addresses.map(ip => `http://${ip}:${server.port}`).join(' or ')}: seat them as Friend, then send each one their link from the Invite button.`
      : 'No home network address was found, so friends cannot join yet. Connect to Wi-Fi and restart the table.');
  }
  if (tunnel) {
    console.log('Opening a Cloudflare quick tunnel for friends on other networks...');
    try {
      const { url } = await tunnel.ready;
      console.log(`Tunnel open at ${url} (a new address can take a minute to work). Play at ${server.url.replace('0.0.0.0', '127.0.0.1')} yourself; friends on any network join with the links from the Invite button, which use the tunnel. The tunnel address alone opens no seat.`);
    } catch (error) {
      console.log(`Friends on other networks cannot join: ${error.message}. The table still runs on this computer.`);
    }
  }
  console.log('Play chips only. Press Ctrl-C to stop.');
  await new Promise(resolve => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  tunnel?.stop();
  await guest?.close();
  await server.close();
  // Give an unfinished match a moment to write its hand log.
  let grace;
  await Promise.race([table.finished(), new Promise(resolve => { grace = setTimeout(resolve, 1500); })]);
  clearTimeout(grace);
  await learning?.settle(5000);
}

async function pokerCommand(args) {
  if (args[0] === 'train' || args[0] === 'merge') {
    if (!learner) throw usageError(`openpoker ${args[0]} needs the Learner add-on, which is not installed (addons/learner/)`);
    const commands = learner.createLearnerCommands({ parseOptions: (...parsed) => { const result = parseOptions(...parsed); editionDefaults(result.options); return result; }, usageError, integerOption, print });
    return await commands[args[0]](args.slice(1));
  }
  const { options, operands } = parseOptions(args, new Set(['--opponent', '--policy', '--players', '--claude-model', '--codex-model', '--opencode-model', ...EXTRA_PLAYERS.map(player => player.option), '--hands', '--stack', '--blinds', '--turn-limit', '--seed', '--port', '--env-file', '--model', '--output-dir', '--format']), new Set(['--auto', '--show-decisions', '--web', '--lan', '--tunnel']));
  editionDefaults(options);
  if (operands.length) throw usageError('poker does not accept operands');
  if (options.format && options.format !== 'json') throw usageError('--format only supports json');
  const opponent = options.opponent || 'rule';
  if (!WEB_PLAYER_IDS.slice(1).includes(opponent)) throw usageError(`--opponent must be one of: ${WEB_PLAYER_IDS.slice(1).join(', ')}`);
  if (!['rule', 'jev', 'learner'].includes(opponent) && !options.web) throw usageError(`--opponent ${opponent} requires --web: Claude, Codex, OpenCode and open-seat agents play through the table server`);
  if (options.policy !== undefined && (options.web || opponent !== 'learner')) throw usageError('--policy goes with --opponent learner outside --web; at the table write --players you,learner:NAME');
  for (const flag of ['players', 'claude_model', 'codex_model', 'opencode_model', ...EXTRA_PLAYERS.map(player => optionKey(player.option)), 'turn_limit']) {
    if (options[flag] !== undefined && !options.web) throw usageError(`--${flag.replace('_', '-')} requires --web`);
  }
  const auto = Boolean(options.auto);
  if (options.format === 'json' && !auto) throw usageError('--format json requires --auto; an interactive game prints to the terminal');
  if (options.web && (auto || options.show_decisions)) throw usageError('--web cannot be combined with --auto or --show-decisions; the table always shows the bot\'s choices after each hand');
  if (options.port !== undefined && !options.web) throw usageError('--port requires --web');
  if (options.lan && !options.web) throw usageError('--lan requires --web');
  if (options.tunnel && !options.web) throw usageError('--tunnel requires --web');
  // A fixed seed fixes the deal: anyone who knows it could rebuild every hand, so a table others can reach never takes one.
  if (options.seed !== undefined && (options.lan || options.tunnel)) throw usageError('--seed cannot be used with --lan or --tunnel: a known seed would let a player rebuild the deck');
  const hands = integerOption(options.hands, auto ? 200 : 20, '--hands', MATCH_LIMITS.maxHands);
  if (auto && hands % 2 !== 0) throw usageError('--auto needs an even --hands: every deal is played twice with the seats swapped');
  // A played game starts with 10,000 chips and 50/100 blinds. `--auto` keeps 200 chips and 1/2
  // blinds, the same 100 big blinds, so its results stay comparable with the recorded pilot.
  const stack = integerOption(options.stack, auto ? 200 : 10_000, '--stack', MATCH_LIMITS.maxStack);
  const blinds = parseBlinds(options.blinds, auto ? { smallBlind: 1, bigBlind: 2 } : { smallBlind: 50, bigBlind: 100 });
  if (stack < MATCH_LIMITS.minStack || stack < blinds.bigBlind * 2) throw usageError(`--stack must be an integer from ${MATCH_LIMITS.minStack} to ${MATCH_LIMITS.maxStack} and at least two big blinds`);
  const seed = integerOption(options.seed, randomInt(1, 2 ** 31), '--seed', 2 ** 32 - 3);
  // The deck has its own stream, so one seed deals the same cards whatever the players decide.
  // Each bot estimates its odds from a separate stream.
  const random = seededRandom(seed);
  const baselineRandom = seededRandom(seed + 1);
  const botRandom = seededRandom(seed + 2);
  const outputDir = options.output_dir || DEFAULT_OUTPUT_DIR;
  const model = options.model || DEFAULT_MODEL;

  if (options.web) return await pokerWebCommand({ options, opponent, hands, stack, blinds, model, outputDir });
  // A game played in the terminal is kept for the add-on's bot; one measured by --auto is not.
  const bot = await createPokerBot(opponent, { hands, model, keys: createJevKeyStore({ envFile: options.env_file, dataDir: outputDir }), outputDir, random: botRandom, policy: options.policy, learn: opponent === 'learner' && !auto });

  const startedAt = Date.now();
  let match;
  if (auto) {
    match = await playMatch({
      players: [createRulePlayer({ name: 'Rule bot (baseline)', random: baselineRandom }), bot],
      hands,
      stack,
      ...blinds,
      resetStacks: true,
      duplicate: true,
      random,
      onEvent: event => {
        if (event.type === 'hand_end' && options.format !== 'json' && event.hand_number % 50 === 0) process.stderr.write(`hand ${event.hand_number}/${hands}\n`);
      }
    });
  } else {
    const terminal = createTerminalGame({ input: process.stdin, output: process.stdout, humanSeat: 0, opponentName: bot.name, showDecisions: Boolean(options.show_decisions) });
    console.log(`Heads-up Texas Hold'em against ${bot.name}. Play chips only. ${hands} hands, blinds ${blinds.smallBlind}/${blinds.bigBlind}, ${stack} chips each.`);
    try {
      match = await playMatch({
        players: [terminal.player, bot],
        hands,
        stack,
        ...blinds,
        random,
        onEvent: async event => {
          await terminal.onEvent(event);
          if (event.type === 'hand_end') bot.endHand?.({ finalStack: event.result.stacks[1], bigBlind: blinds.bigBlind });
        }
      });
    } finally {
      terminal.close();
      if (bot.policyName) await learner.saveExperience({ outputDir, player: bot, source: 'terminal' });
    }
  }

  const report = pokerReport(match, { mode: auto ? 'auto' : 'interactive', opponent, seed, model, startedAt });
  const artifacts = await writePokerLog(report, outputDir);
  // The add-on reads a game against its bot at once.
  if (!auto && opponent === 'learner') await learner.learnFromGame({ outputDir, name: bot.policyName }).catch(error => console.error(`The Learner could not learn from this game: ${error.message}`));
  const { log, ...summary } = report;
  if (auto) return print({ ...summary, artifacts }, options.format);
  const you = match.players[0];
  const ending = { hands_complete: 'All hands played.', player_out_of_chips: 'A player ran out of chips.', player_quit: 'You stopped the game.' }[match.stop_reason];
  console.log(`\n${ending} You finished ${you.net_chips >= 0 ? 'up' : 'down'} ${Math.abs(you.net_chips)} chips over ${match.hands_played} ${match.hands_played === 1 ? 'hand' : 'hands'}.`);
  if (summary.jev?.asked) console.log(`Jev chose ${summary.jev.played_by_jev} of ${summary.jev.asked} decisions; the rule bot stepped in for ${summary.jev.rule_bot_stepped_in}.`);
  console.log(`Hand log: ${artifacts.json}`);
}

// Whether the table's port is free on this computer.
function portFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** `openpoker doctor`: what is ready on this computer, and what each missing piece would need. It reads no key aloud. */
async function doctorCommand(args) {
  const { options, operands } = parseOptions(args, new Set(['--port', '--env-file', '--output-dir', '--format']), new Set());
  editionDefaults(options);
  if (operands.length) throw usageError('doctor does not accept operands');
  if (options.format && options.format !== 'json') throw usageError('--format only supports json');
  const port = options.port === undefined ? 8787 : Number(options.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw usageError('--port must be an integer from 1 to 65535');
  const major = Number(process.versions.node.split('.')[0]);
  const outputDir = path.resolve(options.output_dir || DEFAULT_OUTPUT_DIR);
  const dataExists = await fs.access(outputDir).then(() => true, () => false);
  const tools = Object.fromEntries(Object.keys(AGENT_CLIS).map(kind => [kind, inspectAgentCli(kind)]));
  const cloudflared = spawnSync('cloudflared', ['--version'], { encoding: 'utf8', timeout: 8000, shell: false });
  const tunnelReady = !cloudflared.error && cloudflared.status === 0;
  const report = {
    schema_version: 'openpoker/doctor/v1',
    node: { version: process.versions.node, ready: major >= 20, needs: '20 or newer' },
    data: { folder: outputDir, exists: dataExists },
    port: { number: port, free: await portFree(port) },
    players: {
      you: { ready: true },
      bot: { ready: true },
      claude: { ready: tools.claude.available, version: tools.claude.version, needs: 'Claude Code (the claude command), signed in' },
      codex: { ready: tools.codex.available, version: tools.codex.version, needs: 'the codex command, signed in' },
      opencode: { ready: tools.opencode.available, version: tools.opencode.version, needs: 'the opencode command' },
      ...Object.fromEntries(EXTRA_PLAYERS.map(extra => [extra.id, extra.doctor()])),
      jev: { ready: await createJevKeyStore({ envFile: options.env_file, dataDir: outputDir }).has(), needs: options.env_file ? 'TYPESAFE_API_KEY in the environment or in the --env-file file, or add it on the start screen' : 'TYPESAFE_API_KEY in the environment, in .env in the folder you start from or in the data folder, or add it on the start screen' },
      open_seat: { ready: true }
    },
    friends: {
      lan: { addresses: lanAddresses() },
      tunnel: { ready: tunnelReady, version: tunnelReady ? (cloudflared.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? cloudflared.stdout.trim().split('\n')[0]) : null, needs: 'cloudflared (on a Mac: brew install cloudflared)' }
    },
    addons: learner ? ['learner'] : []
  };
  if (options.format === 'json') return print(report, 'json');
  const mark = ready => (ready ? 'ready  ' : 'missing');
  const row = (label, ready, detail) => `  ${mark(ready)}  ${label.padEnd(15)}${detail}`;
  const player = (label, entry) => row(label, entry.ready, entry.ready ? (entry.version ?? '') : entry.needs);
  const lines = [
    'OpenPoker doctor',
    '',
    row('Node.js', report.node.ready, `${report.node.version}${report.node.ready ? '' : ` (needs ${report.node.needs})`}`),
    row('Port', report.port.free, report.port.free ? `${port} is free` : `${port} is in use: stop the other table, or pass --port`),
    `  ${'info   '}  ${'Data'.padEnd(15)}${outputDir}${dataExists ? '' : ' (made on first use)'}`,
    '',
    'Players',
    row('You, Bot', true, 'always'),
    player('Claude', report.players.claude),
    player('Codex', report.players.codex),
    player('OpenCode', report.players.opencode),
    ...EXTRA_PLAYERS.map(extra => player(report.players[extra.id].label ?? extra.name, report.players[extra.id])),
    row('Jev', report.players.jev.ready, report.players.jev.ready ? 'TypeSafe key found' : report.players.jev.needs),
    row('Open seat', true, 'your own program, see examples/poker-agent.mjs'),
    '',
    'Friends',
    row('Wi-Fi (--lan)', report.friends.lan.addresses.length > 0, report.friends.lan.addresses[0] ? `http://${report.friends.lan.addresses[0]}:${port}` : 'no network address found'),
    row('Anywhere', tunnelReady, tunnelReady ? `--tunnel (cloudflared ${report.friends.tunnel.version})` : report.friends.tunnel.needs),
    '',
    report.addons.length ? `Add-ons: ${report.addons.join(', ')}` : 'Add-ons: none',
    '',
    report.node.ready ? 'Start the table: npm start   (on your Wi-Fi: npm run lan, from anywhere: npm run tunnel)' : 'Install Node.js 20 or newer first: https://nodejs.org'
  ];
  return print(lines.join('\n'));
}

/** The `openpoker` command: the game, `doctor`, and an add-on's own commands. */
export async function main(argv) {
  const args = [...argv];
  if (['help', '--help', '-h'].includes(args[0])) {
    console.log(USAGE);
    return undefined;
  }
  if (args[0] === 'doctor') return await doctorCommand(args.slice(1));
  return await pokerCommand(args);
}
