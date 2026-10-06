# Poker personas, leaderboard, game summary and sound — Design Spec

- **Date:** 2026-09-30
- **Status:** Built
- **Context:** It extends the [seats, models and clock spec](2026-09-30-poker-seats-models-clock.md).

## Goal

The host can save named players ("personas"), see how good each one is, read what each has played, and rank them against each other. A game can be closed at any time and always ends with a summary. Every action at the table makes a sound.

## Scope

**In:**

- **Persona:** a saved player with a name of the host's choosing and the seat it plays: player type (You, Jev, Claude, Codex, OpenCode, Bot, open seat), model, reasoning switch, playing style and style note.
- **Skill:** a rating that starts at 1,000 and moves after every match, shown with big blinds won per 100 hands, match win rate and average reasoning time. Skill is measured, not set by hand.
- **History log:** one entry per match: when, hands, place, opponents, chips won or lost, rating before and after, and how the match ended.
- **Ranking:** a leaderboard of all personas by rating.
- **Close game:** ends the running game at once. The hand in progress is abandoned and not counted. Since 2026-10-02 the host's page then goes back to the start screen ("Choose who plays", no mode picked); "Back to the table" shows the closed game and its summary, and the game is in the History.
- **Game summary:** shown whenever a match is over: why it ended, hands, duration, standings, per-player figures, the biggest pot, and rating changes.
- **Sound:** synthesized in the page for deals, each kind of action, the turn warning and wins, with a mute switch.

**Out:**

- A skill level set by hand, or handicaps.
- Ratings for `--auto` runs or the terminal game. Only browser-table matches are rated.
- Sharing, exporting or syncing personas. They live in one private local file.
- Seating a persona from `--players` on the command line.
- Audio files. Every sound is generated in the browser.

## Acceptance criteria

- Given a name of 1 to 24 characters that no persona uses, when the host creates a persona, then it is saved with a rating of 1,000 and appears in the list and the leaderboard. A taken name, in any letter case, is refused.
- Given a persona, when it is picked for a seat, then the seat plays with the persona's type, model, reasoning and style, and shows the persona's name and rating. The same persona cannot take two seats; a human persona takes the bottom seat only.
- Given a match with at least one finished hand and at least one persona, when it ends for any reason, then each persona's rating, totals and history log are updated, and the summary shows each rating before and after.
- Given a match closed before any hand finished, when it ends, then no rating or history changes.
- Given a seat with no persona, when ratings are worked out, then it counts as a 1,000-rated guest and nothing is stored for it.
- Given a persona seated in a running game, when the host tries to delete it, then the request is refused.
- Given a running game, when the host closes it, then the state is `match_over` with `stop_reason: "closed"` and a summary.
- Given a closed game, when the host's page shows it (the page that closed it, another host page, or a reload), then the start screen opens once with no mode picked, and the summary opens only after "Back to the table". A game that ends on its last hand still opens the summary.
- Given any finished match, when the summary shows, then chips won across all players sum to zero and final chips match the table.
- Given sound is on, when a new action arrives, then one sound plays for it; replaying the same state plays nothing; with sound muted nothing plays.

## Design

**Words.** In the page a *persona* is a saved player. The playing style (Tight-aggressive and so on) is a *style*; it was briefly called a persona in code and was renamed (`src/styles.mjs`, the `style` and `style_note` seat fields, `poker-decision-styles/v1`).

| File | Responsibility |
| --- | --- |
| `src/ranking.mjs` | Rating changes for one match and finishing places |
| `src/persona-store.mjs` | The persona file: create, list, show, remove, record a match |
| `src/table-session.mjs` | Persona seats, `close()`, the match summary, recording results |
| `src/server.mjs` | `/personas` routes and `POST /close` |
| `src/table.html` | Persona manager, leaderboard, history log, close button, summary, sounds |

**Storage.** `~/.openpoker/poker/personas.json` (`jev/poker-personas/v1`), mode `0600` in a `0700` directory, written to a temporary file and renamed. Changes run one at a time. At most 50 personas; each keeps its latest 200 history entries.

**Rating.** After a match every player is compared with every other player on chips won. The expected result comes from the two ratings (the Elo formula, scale 400); the change is `32 × Σ(actual − expected) ÷ (players − 1)`, rounded. Beating a higher-rated player earns more. A tie shares. A match win is counted only for a sole first place.

**Routes.** `GET /personas`, `GET /personas/:id` (with history), `POST /personas`, `DELETE /personas/:id`, `POST /close`. `POST /new` takes a seat written as `{ "persona": "<id>" }`. A persona is validated exactly as a seat is, so its type must be available and its model, reasoning switch, style and note must fit the type.

**Summary.** `match` in the state gains `duration_ms`, `summary.seats[]` (chips won, final chips, hands won, biggest pot won, decisions, reasoning total, mean and longest, timeouts, stand-ins), `summary.biggest_pot`, `summary.showdowns` and `ratings[]`.

**Sound.** The page builds each sound from Web Audio oscillators and noise. The audio context starts on the first click or key press, as browsers require. A sound plays only for an event the page has not seen before, the same rule the motion alerts use. The mute setting is kept in the browser's local storage.

## Constraints and risks

- A rating from a handful of short matches is mostly luck. It needs many matches to mean much, and it only compares personas that have met at this table.
- Chips won in one match decide the rating, so a 3-hand match moves ratings as much as a 50-hand one.
- The persona file holds names and results only, no keys. It is local and unencrypted.
- A style note is the host's own text. It is stored and shown as plain text and quoted in a model's prompt.
- Sound cannot be checked by an automated test for how it sounds, only for when it is scheduled.

## Verification

- `tests/poker-persona.test.mjs` (5 tests): rating maths and places; the store (names, uniqueness, ranking, totals, history, private file, concurrent changes, removal); persona seats, ratings and history after a real match; closing with and without finished hands; the routes over HTTP.
- `npm run check`: 135 tests pass, 0 fail, with five opt-in browser tests skipped (140 total)
- Browser check: three test personas (a person and two bots with different styles) were created, seated with a guest bot and played for three hands; the game was closed from the header after a confirmation; the summary showed the reason, the standings with the winner in gold, the per-player figures and each rating before and after; the leaderboard ranked the three and the history log showed the match. The test personas were deleted afterwards. Sound was checked by counting what the page scheduled: nothing while muted, oscillators and noise for each action when on.

## Open questions

1. Should longer matches count for more in the rating?
2. Should a persona be seatable from the command line?
3. Should `--auto` be able to rate personas over thousands of hands, so a rating means more?
