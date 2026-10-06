---
name: openpokersetup
description: Set up, check, start and troubleshoot OpenPoker, the local Texas Hold'em table (play chips only) where people, rule bots and AI agents (Claude, Codex, OpenCode, Jev, or your own program) play each other. Use when someone wants to install or run OpenPoker, seat AI players, invite friends on their Wi-Fi or from anywhere, or fix a table that will not start.
---

# OpenPoker setup

OpenPoker runs on the person's own computer with Node.js 20 or newer and no npm packages. Everything below is run from the OpenPoker folder.

## 1. Check the computer

```bash
bash scripts/setup.sh
```

This checks Node.js and runs `npm run doctor`, which lists what is ready and what each missing piece needs:

- the port (8787 by default) and the data folder (`~/.openpoker`)
- each AI player's command-line tool
- the Jev key (it says only whether the key is found, never the key)
- `cloudflared` for friends from anywhere
- any add-ons

Read the output to the person in plain words. Nothing is installed or changed.

If Node.js is missing or older than 20, tell the person to install it from https://nodejs.org and stop there.

## 2. Start a table

| The person wants | Command | Then |
|---|---|---|
| To play on this computer | `npm start` | Open http://127.0.0.1:8787 and choose who plays |
| Friends on the same Wi-Fi | `npm run lan` | Start screen → **Friends' table**, seat them, deal; send each friend their link from the **Invite** window |
| Friends anywhere | `npm run tunnel` | Same as above; the links use a `https://….trycloudflare.com` address that can take a minute to work |
| The `openpoker` command anywhere | `npm link` (once) | Then `openpoker --web`, `openpoker doctor`, `openpoker --help` |

Seats can also be named on the command line, for example `npm start -- --players you,claude:sonnet,bot+tight_aggressive`. A host who only wants to watch puts a Friend in seat 0 too; friends then deal each next hand themselves.

The server runs until it is stopped (Ctrl-C). Stop it when the person is done, especially a tunnel.

## 3. AI players

Each AI player uses a tool the person has already installed and signed in to; OpenPoker reads no keys for them.

- **Claude:** `claude` (Claude Code). **Codex:** `codex`. **OpenCode:** `opencode`.
- **Jev:** a TypeSafe API key. The simplest way: the person pastes it into the Jev key box on the start screen (Remember keeps it in `~/.openpoker/.env`). It also works from `TYPESAFE_API_KEY` in the environment or a `.env` file in the folder the table starts from.
- **Open seat:** the person's own program, through the seat protocol in `examples/poker-agent.mjs`.

The person signs in to each tool themselves, under that provider's terms: for Claude and Codex an API key is the clearly permitted way to run them from a program. See the README section "AI tools and their terms".

Never type, ask for, print or store a password, API key or token on their behalf: the person types the Jev key into the box themselves. Never commit `.env`.

At the standard 30-second turn clock, slow players can time out (they then check or fold). Suggest a model with reasoning off (`@fast`, for example `claude:haiku@fast`) or a longer clock (Long 60 s on the start screen, or `--turn-limit 60`).

## 4. Troubleshooting

| Problem | What to do |
|---|---|
| `Port 8787 is in use` | Another table is running: stop it, or start with `npm start -- --port 8788` |
| A friend's link says it is not valid | The table was restarted, so every link changed; send new links from **Invite** |
| The tunnel address does not open | Wait a minute and try again; check `npm run doctor` shows `cloudflared` ready |
| An AI player always checks or folds | Its tool is not signed in, or it runs out of time: run the tool once by hand, then try `@fast` or a longer clock |
| The page says "Lost contact" | The table stopped; start it again |

## Rules

- Play chips only. Never connect OpenPoker to a poker site or anything with real money.
- `--lan` and `--tunnel` expose only friends' seats, but anyone holding a link can play that seat until the table restarts: tell the person to share links privately.
- Keep saved games out of the repository; they live in `~/.openpoker`.
