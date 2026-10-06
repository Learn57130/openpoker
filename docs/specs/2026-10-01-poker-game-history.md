# Poker game history log — Design Spec

- **Date:** 2026-10-01
- **Status:** Built
- **Context:** It extends the [personas, leaderboard and summary spec](2026-09-30-poker-personas-leaderboard.md).

## Goal

The host can look back at every game played at the table: who played, who won, and each hand move by move. A persona's history log already lists the games one persona played; this log lists every game, whoever played it.

## Scope

**In:**

- **Game list:** every saved browser-table game and terminal game, newest first: when it was played, the players, hands played, the winner, each player's chips won or lost, how long it took, and how it ended. The game being played now is listed first, marked "In progress", with the hands finished so far.
- **Game detail:** the game's facts (hands, duration, blinds, turn limit, why it ended), the standings, and every hand: the button, the cards, the board, each action with its time, timeouts and moves the rule bot played in, and who won each pot with what.
- **Card rule:** the history shows what the table showed. In a game with a person in the bottom seat, that seat's cards and the cards shown at a showdown; in a game with no person, every hand. A folded hand is never shown.
- A **History** button in the header, on the start screen and in the game summary.

**Out:**

- `--auto` runs. They are measurement runs of thousands of hands, and their reports are read as files.
- Deleting, renaming, filtering or exporting games. The logs are private files under `~/.openpoker/poker/` and are never changed once written.
- Replaying a hand with animation.
- Model replies and open-seat notes. They are untrusted text and a hand replay does not need them.

## Acceptance criteria

- Given saved web, terminal and `--auto` logs, when the game list is read, then the web and terminal games appear newest first and the `--auto` runs do not. The persona file and any file that is not a game log are ignored.
- Given a game with a person in the bottom seat, when one of its hands is read, then the person's cards and every card shown at a showdown appear, and the cards of a player who folded do not.
- Given a game with no person seated, when one of its hands is read, then every dealt hand appears.
- Given a game id that is not the shape of a saved log (for example one containing `..` or `/`), when it is requested, then it is refused before any file is read.
- Given a running game with one finished hand, when the list is read, then that game is first, marked in progress, with one hand. Once the game is over it is no longer listed as in progress; its saved log takes its place.
- Given a hand in the history, when it is read, then each action carries who acted, the street, the action, the amount, the time taken, and whether it timed out or the rule bot stood in. No model reply or agent note appears.

## Design

**Files.** `src/game-history.mjs` exports `createGameHistory({ directory })` with `list()` and `get(id)`. It reads the match logs in `<outputDir>/poker/` (the directory `writePokerLog` writes and the persona store uses). Logs are written once and never changed, so each file is parsed once and kept in memory. A game id must match the run id `makeRunId()` produces, `YYYY-MM-DDTHH-MM-SS-mmmZ-xxxxxxxx`, before a file name is built from it.

**Showdown cards.** A match log keeps every seat's hole cards but not which ones were shown. A seat showed its cards when the hand ended in a showdown, the seat was dealt in, and it did not fold. Web logs name the player type of each seat, so a game had a person when seat 0 was `human`; the terminal game always seats the person at seat 0.

**How a game ended.** The log records `hands_complete`, `player_out_of_chips` or `player_quit`. The last covers a game closed from the page, replaced by a new game, or stopped with the server, so it shows as "Ended early".

**Current game.** `createTable` takes `gameHistory` the way it takes `personaStore`. At the end of each hand the session keeps a compact record of it on the running game (not in the page snapshot, so the snapshot does not grow). `games()` returns `{ current, games }`, with `current` set only while a game is running; `game('current')` returns its detail.

**Server.** `GET /games` returns `{ current, games }`; `GET /games/:id` returns `{ game }` for a run id or `current`. An unknown id is `404 GAME_NOT_FOUND`. Like `/state`, these routes can show the person's own past cards, so an agent in an open seat should read only `/seats/N/view`.

**Page.** A `games` dialog with two views: the list, and one game's detail with a collapsible section per hand. It reuses the helpers that write "This hand".

## Constraints and risks

- Listing parses every saved log once; a 1.3 MB `--auto` report is parsed only to be skipped, then remembered. A file that does not parse is not remembered, so a log read while it is still being written is read again next time.
- The list has no cap. The 36 logs saved by 2026-10-01 list as 27 games in about 50 ms the first time and at once after that.
- A game with no hand finished still appears, with zero hands, so a quick closed game is not lost from view.

## Verification

- `tests/poker-history.test.mjs` covers every acceptance criterion with temporary logs and an in-process table.
- In the browser: the list shows the saved games, and one real game opens with folded cards hidden and showdown cards shown.

## Open questions

- None.
