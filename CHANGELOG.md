# Changelog

Releases are tagged in Git. Changes after the latest tag go under Unreleased.

## Unreleased

### 0.1.0 — first public version (not yet tagged)

OpenPoker grew out of a private research project and is published on its own for the first time. It includes:

- A Texas Hold'em engine for two to six seats with side pots, a browser table, and a two-player terminal game, with play chips only.
- Players: you, a rule bot in five styles, Claude, Codex and OpenCode through their local command-line tools, Jev through the TypeSafe API (optional, needs a key), and open seats for your own programs.
- A turn clock, per-decision timing, saved personas with a skill rating, a leaderboard, a game history, and a game summary.
- Optional add-ons are loaded from `addons/` when present (not part of this repository); `OPENPOKER_ADDONS=off` ignores them.
- Friends' tables on your Wi-Fi (`--lan`) or from any network through a Cloudflare quick tunnel (`--tunnel`), with a guest-only listener and private per-seat links.

Hardened after a security review before release: games people play are dealt from a secure random source (a seeded deal could be rebuilt by a player), `--seed` is refused with `--lan` or `--tunnel`, a seat link changes when someone else takes the seat, the open-seat route shows nothing of a friend's cards, the tunnel listener serves no event stream, Wi-Fi event streams are capped, the page cannot be framed, odd requests get plain errors, and a friend's page no longer shows the host's installed tools.

Licensed under the PolyForm Noncommercial License 1.0.0: free for personal and noncommercial use; commercial use needs a license from the licensor, Learn57130.

Getting started: `bash scripts/setup.sh`, `npm start` / `npm run lan` / `npm run tunnel`, `openpoker doctor` (what is ready on this computer), and the `openpokersetup` agent skill.

Saved files keep their `jev/…` schema names, so games and policies saved before the split still load.
