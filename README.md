# OpenPoker

Texas Hold'em for two to six seats in your browser, where people, rule bots and AI agents (Claude, Codex, OpenCode, Jev, or your own) play each other. Friends join from their own phones or laptops with a private link.

**Play chips only.** OpenPoker never connects to a poker site and never handles real money. It is not a gambling product.

**Free for personal and noncommercial use.** Commercial use needs a license; see [License](#license).

Status: alpha (0.1.0). It runs locally with Node.js and has no npm dependencies.

| Document | Purpose |
| --- | --- |
| [Changelog](CHANGELOG.md) | What changed, version by version |
| [Security](SECURITY.md) | What the table exposes, and how to report a problem |
| [Contributing](CONTRIBUTING.md) | Running the tests and sending changes |
| [Agent guide](AGENTS.md) | Rules for AI coding agents working in this repository |
| [Two-player game and agent seats](docs/specs/2026-09-30-heads-up-poker.md) | The first design, the measurement method, the open-seat protocol v1 |
| [Seats, models, clock, styles](docs/specs/2026-09-30-poker-seats-models-clock.md) | Two to six seats and side pots, model choice, the reasoning switch, playing styles, the AI players, turn timing, seat protocol v2 |
| [Personas, leaderboard, summary, sound](docs/specs/2026-09-30-poker-personas-leaderboard.md) | Saved players with a skill rating, closing a game, the game summary, sounds |
| [Game history](docs/specs/2026-10-01-poker-game-history.md) | Every game, hand by hand, and what each hand may show |
| [Friends' table](docs/specs/2026-10-01-poker-friends-table.md) | Friends on your Wi-Fi playing from their own devices |
| [Friends from any network](docs/specs/2026-10-05-poker-tunnel.md) | A Cloudflare quick tunnel to a guest-only listener |
| [Jev key from the start screen](docs/specs/2026-10-06-jev-key-from-the-page.md) | Adding Jev's TypeSafe key on the page, where it is kept, and what never shows it |

## Quick start

You need Node.js 20 or newer (macOS or Linux; the commands below use a Unix shell).

```bash
git clone https://github.com/Learn57130/openpoker.git
cd openpoker
bash scripts/setup.sh
npm start
```

`scripts/setup.sh` checks your computer and says what is ready: the port, each AI player's tool, the Jev key, `cloudflared` for friends. It installs and changes nothing. Then open `http://127.0.0.1:8787` and choose who plays.

| Command | What it does |
| --- | --- |
| `npm start` | The browser table on this computer, port 8787 |
| `npm run lan` | The table also listens on your Wi-Fi, so friends there can take seats |
| `npm run tunnel` | Friends on any network join through a Cloudflare quick tunnel (needs `cloudflared`) |
| `npm run doctor` | Checks again what is ready, and what anything missing needs |
| `npm start -- --players you,claude:sonnet,bot` | Starts with these seats; add `--port N`, `--turn-limit SECONDS` or other options after `--` |

To type `openpoker` anywhere instead, run `npm link` once in the folder: `openpoker --web`, `openpoker doctor`, `openpoker` (a two-player game in the terminal), `openpoker --auto --opponent jev --hands 200` (Jev against the rule bot on mirrored deals). `openpoker --help` lists every option.

**With an AI coding agent.** The repository includes an agent skill, `openpokersetup` (`.claude/skills/openpokersetup/SKILL.md`), so an agent such as Claude Code can check, start and troubleshoot the table for you: ask it to "set up OpenPoker".

## Who can sit at the table

| Player | Type | Needs |
| --- | --- | --- |
| You | `you` | Nothing |
| Bot | `bot` | Nothing. Plays by the odds, in one of five styles: balanced, tight-aggressive, loose-aggressive, rock, calling station |
| Claude | `claude` | The `claude` command (Claude Code), signed in |
| Codex | `codex` | The `codex` command, signed in |
| OpenCode | `opencode` | The `opencode` command |
| Jev | `jev` | A TypeSafe API key: paste it in the start screen's Jev key box (tick Remember to keep it in `~/.openpoker/.env`), or set `TYPESAFE_API_KEY` in the environment or a `.env` file in the folder you start from. A wrong key shows on Jev's first move, when the Bot plays for it |
| Open seat | `agent` | Your own program, through a small HTTP seat protocol (see `examples/poker-agent.mjs`) |
| Friend | `friend` | `--lan` or `--tunnel`; the friend opens their private link |

The AI players run the command-line tools already signed in on your computer; OpenPoker ships no AI tools, keys or accounts and reads no keys for them (see [AI tools and their terms](#ai-tools-and-their-terms)). Each may answer only with one of the legal moves the code lists; anything else and the rule bot plays that move. Seat them from the start screen, or name the seats on the command line: `openpoker --web --players you,claude:sonnet,learner,bot+tight_aggressive`.

## AI tools and their terms

Each AI player you seat runs a tool installed on your computer, signed in with your own account, so that provider's terms, usage policies and rate limits apply to you. OpenPoker only starts the tool, sends it the game situation, and plays the one legal move it names.

- **Claude and Codex.** Both document running from scripts. An API key is the clearly permitted way to run them from a program; signing in with a consumer subscription is governed by the provider's terms and may be limited or refused.
- **OpenCode.** Its default model here, `opencode/big-pickle`, runs on OpenCode's hosted service, which may use that data to improve the model while it is free. Pick another `provider/model` to use that provider's terms instead.
- **Jev.** Uses your own TypeSafe API key under TypeSafe's terms.
- **What leaves your computer.** The game situation (cards you can see, the board, the bets, the clock) goes to the provider of each AI seat and may be stored or reviewed under its terms. Keep personal information out of style notes and player names.

Play chips only: no real money, no prizes, no cash-out. OpenPoker must never be connected to a poker site or used for gambling.

## Playing with friends

On the start screen choose **Friends' table**, seat your friends, and deal. The **Invite** window lists one private link per friend; each friend sees only their own cards. To sit out and let friends play the AI players, put a Friend in seat 0 too; they deal each next hand themselves.

- `--lan` listens on your home network. Other computers may open only the friend's page and their own seat.
- `--tunnel` opens a Cloudflare quick tunnel (a free service Cloudflare offers for testing, with no uptime guarantee and no account needed) to a separate, guest-only listener, so nothing that runs the table is reachable from the internet. The private link is the only gate, so share links privately. Every start gives a new address and new links.

See [SECURITY.md](SECURITY.md) for the details.

## Your data

Saved games and personas live in `~/.openpoker/` (set `OPENPOKER_HOME`, or pass `--output-dir`, to move them). Files are private to your user (mode 0600 in 0700 folders). Saved game logs hold every player's cards and every AI reply; the history in the page shows only what the table showed.

## Project layout

| Path | Holds |
| --- | --- |
| `bin/openpoker.mjs`, `src/cli.mjs` | The `openpoker` command |
| `src/cards.mjs`, `evaluate.mjs`, `equity.mjs` | Deck, hand ranking, chance of winning |
| `src/engine.mjs` | The rules: blinds, betting, side pots, showdown, what each seat may see |
| `src/describe.mjs`, `styles.mjs`, `players.mjs` | The situation in words, playing styles, the rule bot, Jev and model players |
| `src/match.mjs` | Plays hands, times every decision, applies the turn limit |
| `src/poker-decision.mjs`, `src/lib/` | Jev's poker question and the small TypeSafe client it uses |
| `src/agent-cli.mjs` | Runs the local `claude`, `codex` or `opencode` command |
| `src/table-session.mjs`, `server.mjs`, `table.html` | The browser table: game state, local server, the page |
| `src/tunnel.mjs` | The Cloudflare quick tunnel for `--tunnel` |
| `src/persona-store.mjs`, `ranking.mjs`, `game-history.mjs` | Personas and ratings, the game history |
| `src/terminal.mjs`, `log.mjs` | The terminal game, the private match log |
| `tests/` | The test suite (`npm test`) |
| `examples/` | An example open-seat agent and a sample Jev request |
| `docs/specs/` | The design specs |

Saved files still carry `jev/…` schema names (`jev/poker-match/v1` and others) from the project OpenPoker grew out of, so earlier saved games and policies keep working.

## Add-ons

OpenPoker loads optional add-ons from `addons/` when they are present. They are not part of this repository, and the game runs fully without them. An add-on can add a bot seat, its own commands, and its own part of the host's page (through `window.OpenPokerPage` in `src/table.html`; the server adds the add-on's markup to the host's page only, never to a friend's). Set `OPENPOKER_ADDONS=off` to ignore any that are installed.

## License

OpenPoker is free for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). That covers:

- personal use: study, private entertainment, hobby projects and home games with friends, with no commercial purpose in mind
- use by a charity, school, public research body, public health or safety body, environmental body or government

You may change it and share it on the same terms, keeping the [NOTICE](NOTICE) file.

Any commercial use needs a separate license from the licensor, Learn57130. This includes selling it, running it as a paid or ad-supported service, building it into a product, or using it in or for a business. To ask, open an issue titled "Commercial license" at https://github.com/Learn57130/openpoker/issues.

Because commercial use is restricted, OpenPoker is source-available rather than open source in the Open Source Initiative's sense.

Claude and Claude Code are trademarks of Anthropic; Codex and ChatGPT of OpenAI; Cloudflare of Cloudflare, Inc. OpenPoker is not affiliated with, sponsored by or endorsed by any of them, or by TypeSafe or OpenCode, and uses their names only to say which tools it can start.
