# Changelog

Releases are tagged in Git. Changes after the latest tag go under Unreleased.

## Unreleased

Nothing yet.

## v0.1.1 — 2026-10-06

- Add Jev's TypeSafe key on the start screen: when a mode can seat Jev, a Jev key box takes the key, makes Jev available at once, and with Remember keeps it in `~/.openpoker/.env` (readable by you only) for the next start. Remove key takes it out again. The key goes only to the table on your computer and is never shown back, sent to friends' pages, or printed by `openpoker doctor`, which now also finds a key in `~/.openpoker/.env`.
- The README opens with a picture of the table, and its example command now seats `opencode` instead of a player type OpenPoker does not have.

## v0.1.0 — 2026-10-06

The first public version.

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
