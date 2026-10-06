# Poker table: 2–6 seats, model choice, turn clock — Design Spec

- **Date:** 2026-09-30
- **Status:** Built
- **Context:** It extends the [heads-up poker spec](2026-09-30-heads-up-poker.md), which listed a table for three or more players as out of scope. Where the two documents differ, this one describes the current code.

## Goal

The host can seat two to six players at the browser table, choose the model behind each agent seat, and see how long every player reasons before each action. An optional limit gives every player the same time for a decision. The table then shows how Jev, Claude, Codex, a rule bot, an outside agent and a person behave against each other in one game.

## Scope

**In:**

- One game engine for two to six seats, with side pots.
- A seat count and a player for each seat on the start screen. The four modes keep their names: "Human vs Bots" is you and one to five bots, and "Agents vs Bots" needs at least one of each.
- A model name for each Jev, Claude or Codex seat, as free text with suggestions. On the command line a seat is written `type:model`.
- Deeper stacks for a played game: 10,000 chips and 50/100 blinds in the terminal and in the browser. `--blinds SB/BB` is new, and `--stack` goes up to 1,000,000.
- A turn clock. It is a stopwatch first: every decision by every player is timed, and each reasoning period is counted. A limit on each decision is optional and is the same for every player.
- A gold mark on the winner or winners of each hand, and on the match winner at the end.
- The model suggestion list opens directly under the model box.
- The open seat protocol for any seat, as `jev/poker-seat/v2`.
- A second wording of the Jev question, `poker-decision-questions/v2`, for a hand with more than two players.

**Out:**

- `openpoker --auto` and the terminal game stay two-player. Mirrored deals and the paired standard error only make sense for two.
- Measuring Jev at a table of three or more. The pilot numbers in the heads-up spec apply to two players only.
- Real money, poker sites, tournaments, antes, rebuys. A player with no chips sits out for the rest of the match.
- A time bank or different limits per player.
- An MCP wrapper (deferred).

## Acceptance criteria

**Engine**

- Given stacks of 10, 50 and 200 and all three players all-in, when the hand ends, then the main pot of 30 goes to the best of three hands, the side pot of 80 to the better of the two larger stacks, the largest stack is never asked for more than the second stack can match, and chips are conserved.
- Given three or more players, when a hand starts, then the seat left of the button posts the small blind, the next posts the big blind, the seat after that acts first before the flop, and the first live seat left of the button acts first on later rounds. With two players the button posts the small blind and acts first before the flop.
- Given a betting round, when every player who is not folded and not all-in has acted since the last raise and has matched the bet, then the round closes. When at most one such player remains, no further betting happens and the board runs out.
- Given a seeded match of any size from two to six, when it is played by rule bots, then every hand conserves chips and no illegal action occurs.
- Given a player with no chips, when the next hand starts, then that player is dealt no cards and the button passes over that seat.
- Given every existing two-player test, when the new engine runs, then it still passes. The same seed gives the same two-player match as before the rewrite.

**Table**

- Given the start screen, when the host picks a mode, then they can set two to six seats, a player for each seat, a model where the player type takes one, and the turn limit. "Deal the cards" starts that game.
- Given a Jev, Claude or Codex seat, when the host types or picks a model, then that seat uses it and its name shows the model. A model name that does not match `^[A-Za-z0-9._:-]{1,64}$` is refused. A model given to a seat that takes none (You, Bot, Open seat) is refused too.
- Given a Claude seat, when a hand ends, then "Choices this hand" shows the model that really answered, as the `claude` command reports it.
- Given a human at the table, when the state is read, then no other seat's cards appear before a showdown, and a folded seat's cards never appear.
- Given no human at the table, when the state is read, then all hands are face up.
- Given a finished hand, when the page shows it, then every seat that won a contested pot is marked in gold. Given a finished match, then the seat with the most chips is marked in gold; a tie for the most chips marks nobody.

**Turn clock**

- Given any action by any player in any mode, when it is logged, then it carries `think_ms`, the time from the start of that turn to the answer. This holds for `--auto` and the terminal game as well as the browser table.
- Given a finished match, when the result is read, then each player has `think_ms_total`, `think_ms_mean` and `think_ms_max`.
- Given a finished hand, when the page shows it, then "Choices this hand" shows how long each action took.
- Given a turn limit of N seconds, when a player has not answered N seconds after their turn began, then a check is played if it is legal, otherwise a fold. The action is marked as timed out, and a Claude or Codex call still running for that turn is stopped.
- Given a turn limit of 0, when any player takes a long time, then nothing is played for them. The stopwatch still runs.
- Given the start screen and no `--turn-limit`, when it opens, then "Standard 30 s" is chosen, next to Fast 15 s, Long 60 s, Extra long 120 s and No limit. (Added 2026-10-01; the default was 120 s before.)
- Given a rule bot or a Jev seat, when its action is held on screen for a moment so it can be followed, then that pause is not counted as reasoning time.

## Design

**One engine.** `src/engine.mjs` handles two to six seats. Seats with no chips are not dealt in. The match runner starts the button at seat 0 and moves it to the next seat with chips each hand; the match ends when fewer than two players have chips. A raise is capped at what the largest live opponent can match. Any raise, including a short all-in, reopens the betting; raises stay capped at four per round. The part of a bet that nobody matched goes back to the bettor when the round closes.

**Side pots.** At showdown the engine walks the distinct contribution levels from smallest to largest. Each level forms a pot from every player's chips up to that level; the best hand among the players who are still in and reached that level wins it. A level reached by one player is that player's unmatched bet and returns to them. Ties split; odd chips go one at a time starting left of the button. The result lists every pot as `{ amount, eligible, winners }`. `winners` names every seat that took a contested pot, and `winner` is set only when there is exactly one.

**Odds against several opponents.** `estimateEquity` deals a random hand to each opponent still in, from one to five. The rule bot and the descriptions compare strength on a two-player scale by taking the K-th root of the win chance against K opponents, so the existing thresholds keep their meaning. The price of calling is compared with the true win chance. The fixed discount of 0.08 for each opponent raise, up to three, still applies to both.

**What Jev sees.** The description is chosen hand by hand from the number of players dealt in. With two players dealt in it is unchanged and the workflow keeps `poker-decision-questions/v1`, so the pilot stays comparable. This also applies at a larger table once only two players still have chips. With more than two dealt in:

- `game` reads "poker at a table of several players, my turn to act".
- `opponents_still_in` and `raises_this_round` are added, as number words from "none" to "five".
- `my_position` is "I act first in this round", "I act in the middle of this round" or "I act last in this round". Before the flop the big blind is described as last and the small blind as "I act near the end of this round".
- `opponent_this_round` is the most aggressive action by any opponent in this round. `opponent_tendencies` describes the last opponent to raise in this hand who is still in it, or the first opponent still in if nobody raised.

The state still holds no card codes and no chip counts.

**Jev question v2.** `src/poker-decision.mjs` uses the v2 wording whenever the situation has an `opponents_still_in` field, and returns `question_version: "poker-decision-questions/v2"` on that decision. The instructions name "a table of several players" and ask Jev to use `opponents_still_in`. Three criteria change: `call` says "the current bet" in place of "the opponent's bet"; `raise_small` with a medium hand applies only when one opponent is still in and that opponent folds often; `raise_large` is preferred to a small raise when two or more opponents are still in. The abstention policy is unchanged (`poker-decision-policy/v1`), and the registered workflow version stays `1.0.0`.

Each Jev decision in the hand log records its own `question_version` in `meta`, so v1 and v2 decisions can be counted. The log's header field `question_version` is written only for a two-seat game with Jev as the opponent and always names v1.

**What Claude and Codex see.** The brief names the table size, the seat and its position, and each opponent's seat with its chips or "folded" or "all-in". The odds line says how many random hands the estimate is against. It never holds another seat's cards.

**Chips and blinds.** A played game, in the terminal or the browser, starts with 10,000 chips and 50/100 blinds: 100 big blinds deep. `--auto` keeps 200 chips and 1/2 blinds, also 100 big blinds, so new runs stay comparable with the recorded pilot. `--blinds SB/BB` sets the blinds in any mode; the big blind must be at least the small blind. `--stack` takes 20 to 1,000,000 and must cover two big blinds.

**Models.** Three player types take a model. Each carries a list of suggestions in `player_types[].models`:

| Player | Suggestions | Where the name goes |
| --- | --- | --- |
| Jev | `jev-latest`, `jev-preview`, `jev-1.13.0` | The TypeSafe model alias for that seat's client |
| Claude | `fable`, `opus`, `sonnet`, `haiku` | `claude --model` |
| Codex | none; the names depend on the account | `codex exec -m` |

Any other name that matches the pattern is accepted and passed through; this project does not check that the account can use it. `--players you,claude:sonnet` sets a model from the command line. A seat with no model of its own falls back to `--model` (Jev), `--claude-model` or `--codex-model`, and then to the tool's own default. The seat is named with its model, for example "Claude · sonnet"; two seats with the same name get a number. The web hand log lists `{ type, model }` for each seat.

"Choices this hand" carries a `model` field for each decision. For Claude it is the model the `claude` command reports in its usage data, whatever alias was asked for. For Codex it is the name that was asked for, because the tool does not report one. A Jev decision carries no model there; the seat name shows the one that was asked for.

**Table session and server.** Seat 0 is the bottom seat and the only seat a person can take. `POST /new` takes `{ "players": [seat, ...], "turn_limit_ms": N }` with two to six seats, each a type id or `{ "type", "model" }`. Both fields are optional: without `players` the same seats are dealt again, and without `turn_limit_ms` the last limit is kept. A request body may be up to 2048 bytes. `/seats/N/view` and `/seats/N/action` accept seats 0–5. The server checks player types, not modes, so `/new` and `--players` also accept mixes that no mode offers.

**Turn clock.** The match runner (`match.mjs`) times every decision, so the timing is the same for every front end. Each logged action carries `think_ms`, and the match result gives each player `think_ms_total`, `think_ms_mean` and `think_ms_max`. The limit is a separate, optional setting: `--turn-limit SECONDS` with `--web` (default 30, 0 for none, at most 600), or `turn_limit_ms` in `POST /new`, which is what the start screen sends. The start screen names its choices Fast 15 s, Standard 30 s, Long 60 s, Extra long 120 s and No limit; a value set with `--turn-limit` that is not among them gets its own button. Standard, the default since 2026-10-01 (it was 120 s before), follows the 30-second shot clock of live poker. Claude with reasoning on and Codex often take longer, so at 30 s or less the start screen warns that they may time out and suggests Long, Extra long or reasoning off. When the limit passes, the runner plays `check` if it is legal and `fold` if not, logs the action with `source: "fallback"` and `reason: "timeout"`, records `think_ms` equal to the limit, and aborts the player's signal. The Claude and Codex adapter stops its command on that signal; a late click or a late agent answer is refused with `NOT_YOUR_TURN`. `--auto` and the terminal game run with no limit.

This one clock replaces the separate 120-second open-seat limit of the first table. With a limit of 0 an open seat, like a person, may take as long as it likes.

Two other timers are unchanged. A Claude or Codex command is still stopped after 90 seconds by its adapter; the rule bot then plays that turn. So the rule bot steps in when the 90 seconds pass first, and the clock's check or fold is played when the turn limit is shorter. The table holds a rule bot's or Jev's action on screen for 650 ms; that pause comes after the timing and is not in `think_ms`.

**Snapshot.** `/state` gains what the page needs for the above: `settings` (`stack`, `small_blind`, `big_blind`, `turn_limit_ms`, `max_seats`), `players[].model`, `players[].think` (`count`, `total_ms`, `mean_ms`, `max_ms`, `last_ms`), `hand.acting`, `hand.turn_started_at` and `hand.deadline` (wall-clock milliseconds; `deadline` is `null` with no limit), `think_ms` and `timed_out` on each entry of `hand.log`, `hand.result.winners` and `hand.result.pots`, and `match.winner_seat`.

**Page.** Seats sit around the table with the bottom seat nearest the viewer. The page shows a live stopwatch on the acting seat, the time each action took, each player's average, and a "Reasoning time" panel. It marks the winner or winners of each hand in gold, and the match winner in gold when the match ends. The model box on the start screen opens its suggestion list directly under the box; in the first version the list appeared off to the side.

## Open seat protocol v2

The routes, the status values and the loop are the same as in [v1](2026-09-30-heads-up-poker.md#agent-seat-protocol). The schema is `jev/poker-seat/v2` and the seat number runs from 0 to 5.

A view on the seat's turn, shortened. It is seat 2 of four, in the big blind, after two folds and a call:

```json
{
  "schema_version": "jev/poker-seat/v2",
  "seat": 2,
  "status": "your_turn",
  "hand_number": 1,
  "view": {
    "hand_number": 1,
    "seat": 2,
    "seats": 4,
    "players_dealt_in": 4,
    "players_in_hand": 2,
    "in_hand": true,
    "is_button": false,
    "position": "big blind",
    "street": "preflop",
    "hole_cards": ["6s", "3d"],
    "board": [],
    "pot": 200,
    "to_call": 0,
    "stack": 9900,
    "committed": 100,
    "opponent_stack": 9900,
    "opponents": [
      { "seat": 0, "stack": 10000, "committed": 0, "in_hand": false, "all_in": false, "is_button": true },
      { "seat": 1, "stack": 9900, "committed": 100, "in_hand": true, "all_in": false, "is_button": false },
      { "seat": 3, "stack": 10000, "committed": 0, "in_hand": false, "all_in": false, "is_button": false }
    ],
    "big_blind": 100,
    "actions": [
      { "street": "preflop", "seat": 3, "label": "fold", "amount": 0, "to": 0 },
      { "street": "preflop", "seat": 0, "label": "fold", "amount": 0, "to": 0 },
      { "street": "preflop", "seat": 1, "label": "call", "amount": 50, "to": 100 }
    ]
  },
  "legal_actions": [
    { "label": "check", "amount": 0, "to": 100 },
    { "label": "raise_small", "amount": 100, "to": 200 },
    { "label": "raise_large", "amount": 200, "to": 300 },
    { "label": "all_in", "amount": 9900, "to": 10000 }
  ],
  "situation": {
    "game": "poker at a table of several players, my turn to act",
    "my_hand_strength": "weak",
    "price_to_call": "free, nothing to call",
    "my_position": "I act last in this round",
    "opponents_still_in": "one",
    "raises_this_round": "none"
  },
  "odds": { "win_chance": 0.384, "price_to_call": 0, "opponents_in": 1 },
  "opponent_profiles": {
    "0": { "decisions": 1, "raises": 0, "faced_raises": 0, "folds_to_raise": 0 },
    "1": { "decisions": 1, "raises": 0, "faced_raises": 0, "folds_to_raise": 0 },
    "3": { "decisions": 1, "raises": 0, "faced_raises": 0, "folds_to_raise": 0 }
  },
  "last_result": null,
  "deadline": 1790759039611,
  "timeout_ms": 120000
}
```

After the hand, `last_result` for the same seat:

```json
{
  "hand_number": 1,
  "reason": "showdown",
  "you_won": false,
  "winners": [1],
  "pot": 200,
  "your_net": -100,
  "board": ["Kc", "Js", "8d", "Jc", "2d"],
  "hand_names": [null, "one pair", "one pair", null],
  "shown_cards": [null, ["Qs", "6d"], ["6s", "3d"], null]
}
```

| Field | Meaning |
| --- | --- |
| `view.seats` | Seats at the table, two to six |
| `view.players_dealt_in`, `view.players_in_hand` | Players dealt into this hand, and players who have not folded |
| `view.in_hand` | Whether this seat is still in the hand |
| `view.position` | `button`, `button and small blind`, `small blind`, `big blind` or `other` |
| `view.committed` | This seat's bet in the current round |
| `view.opponent_stack` | The largest stack among opponents still in the hand |
| `view.opponents` | One entry for each other player dealt in: `seat`, `stack`, `committed`, `in_hand`, `all_in`, `is_button` |
| `view.actions` | Every action in the hand so far, each with its `seat` |
| `situation` | The same words Jev sees, including `opponents_still_in` and `raises_this_round` at a table of more than two |
| `odds` | `win_chance` against `opponents_in` random hands, and `price_to_call` |
| `opponent_profiles` | Observed counts for every other seat, keyed by seat number |
| `last_result` | The seat's last finished hand. `hand_names` and `shown_cards` have one entry for each seat and are `null` unless the hand reached a showdown; a folded seat's entry stays `null` |
| `deadline` | Wall-clock time in milliseconds when the turn will be played for the seat; `null` when it is not the seat's turn or there is no limit |
| `timeout_ms` | The game's turn limit; `null` when there is none |

When it is not the seat's turn, `view`, `situation`, `odds` and `opponent_profiles` are `null` and `legal_actions` is empty.

**Changed from v1.**

- `seat_name` ("bottom" or "top") is gone. Use `seat`.
- `view` adds `seats`, `players_dealt_in`, `players_in_hand`, `in_hand`, `position`, `committed` and the `opponents` list. `opponent_stack` stays, as the largest live opponent stack.
- `odds` adds `opponents_in`.
- `opponent_profile` (one opponent) became `opponent_profiles` (every other seat).
- `last_result` has a new shape. `you_won` and `winners` replace `winner`, and `shown_cards` replaces `opponent_cards`. `your_net` and `hand_names` are new.
- `deadline` is new.
- `timeout_ms` now comes from the game's turn limit. In v1 it was always 120000.
- Seats 2 to 5 are valid. A seat number above 5 is answered with HTTP 404.

`examples/poker-agent.mjs` reads only fields that both versions have, so it still plays seat 0 or 1. It refuses any other `--seat` value; an agent for seats 2 to 5 must call the routes itself.

**Reasoning switch.** A Claude or Codex seat takes `reasoning: false` in `POST /new` (`@fast` after the seat in `--players`, a switch beside the model box on the start screen). Claude is then started with `MAX_THINKING_TOKENS=0` and answers without thinking first; Codex is asked for `model_reasoning_effort="low"`. The seat's name ends in "fast". Other player types refuse the setting. Measured live on one hand with two Claude Haiku seats: the fast seat averaged 5.0 seconds a decision (longest 7.3), most of it the tool starting up, and the reasoning seat averaged 45.5 seconds (longest 69.3).

**Styles.** A seat can take a playing style: Balanced (the default), Tight-aggressive, Loose-aggressive, Rock (tight-passive) or Calling station (loose-passive). `POST /new` takes `style` on a seat, `--players` takes `+STYLE`, and the start screen has a style picker on every seat except the person's. The definitions are in `src/styles.mjs`. Each player type applies the style in its own way:

- **Bot:** the style moves its thresholds. `raise_shift` is added to the strength needed to bet or raise, and `call_margin` is how far the win chance must clear the price before a call.
- **Jev:** the style replaces the rule written into the answer options (`POKER_STYLE_CRITERIA` in `src/poker-decision.mjs`, recorded as `poker-decision-styles/v1`). The balanced style sends the unchanged v1 or v2 wording, so earlier results stay comparable. When Jev abstains, the rule bot plays in the same style.
- **Claude, Codex, OpenCode:** one line in the prompt names the style and describes it. These seats, and an open seat, also take `style_note`: one line of up to 200 characters in the host's own words, quoted in the prompt as a note. The reply must still be one legal label, and code still validates it.
- **Open seat:** the seat view carries `style` (`id`, `name`, `description`, `note`) for the outside agent to follow or not.

Live probe of the Jev wording: 37 of 40 (eight hand-written situations for each of the five styles). The three misses are all the same kind: asked to bluff with a weak hand, or to call when the description says calling is "not worth it", Jev kept to the numbers and checked or folded.

**OpenCode.** A seventh player type runs the local `opencode run` command with its read-only `plan` agent in an empty folder. Models are named `provider/model`; the suggestions come from `opencode models`, and with no model chosen the seat uses `opencode/big-pickle`, a free model that answered here, because the tool's own default was refused for the account. Reasoning off adds `--variant minimal`. Model names may now contain a slash.

## Constraints and risks

- A full engine rewrite can break two-player behaviour. Every existing test must keep passing, and seeded N-player matches check chip conservation.
- The rule bot's thresholds were chosen for two players. The K-th root scaling is an approximation; the bots are not strong at a full table.
- With five Claude or Codex seats a hand can take minutes.
- A short turn limit times out Claude and Codex, which need seconds for each decision. Their seats then check or fold every turn.
- On the command line a model name cannot contain a colon: `--players` reads only the text between the first and second colon of a seat. `POST /new` accepts colons.
- A model name is checked for its form only. A name the account cannot use fails at that seat's first decision; the rule bot plays and the page shows a notice.
- Any local process can read `/state`; in a game with no human it shows every hand. An outside agent must use `/seats/N/view`.

## Verification

Done:

- `tests/poker-multiway.test.mjs` (8 tests): blind and action order at three and six seats, a raise reopening the betting, side pots for stacks of 10, 50 and 200, a folded player's chips and hidden cards, a split pot with an odd chip, a sat-out seat, odds and descriptions against several opponents, and seeded matches of two to six rule bots that conserve chips.
- Two-player results are unchanged. Rule bot against rule bot with `--seed 21` over 200 mirrored hands still gives +16.5 ± 19.6 big blinds per 100, the figure recorded in the [heads-up spec](2026-09-30-heads-up-poker.md#pilot-results-2026-09-30).
- A five-seat table session (a person, three rule bots and one open seat, with a 150 ms turn limit) was run in process for six hands. Chips were conserved, and the person's and the open seat's timeouts played safe actions.
- Model choice, live: one hand against `claude:haiku`. Four of four decisions were answered by `claude-haiku-4-5-20251001`.
- The v1 question wording was probed live earlier: 16 of 16 hand-written cases matched the intended action.

Results, 2026-09-30:

- `npm run check` with the web tests for the new contract: 135 tests pass, 0 fail, with five opt-in browser tests skipped (140 total)
- Browser check of the rebuilt page with a six-seat game: a six-seat game with a person, Jev, Claude Haiku and three bots was played to a showdown in the browser: seats, 10,000 chips, the live turn timer, per-action times, the reasoning-time panel and the gold winner mark all showed correctly (Jev averaged 0.4 s a decision; Claude Haiku took 9 s and 39 s)
- Live probe of the v2 question wording: 12 of 12 hand-written multiway situations got the intended action, including a small raise with a medium hand against one opponent who folds often and a check in the same spot against three opponents

Known gaps:

- Codex answers again after the host updated the `codex` CLI from 0.145.0 to 0.159.2. One hand at the table had four of four decisions made by Codex, taking 11 to 34 seconds each. A bare call took about 26 seconds with reasoning on or off: most of it is the tool starting up, so the reasoning switch makes no measurable difference for Codex here.
- Not checked by hand in the browser: the match-winner ribbon and a real side pot. The page's author checked both, the side pot against canned data only.
- Not built: `--auto` measurement at three or more seats, a multi-seat terminal game, an MCP wrapper, a time bank, and tournaments.

## Open questions

1. Should a short all-in stop reopening the betting, as in casino rules?
2. Should `--auto` measure Jev at a larger table, and with what variance control?
3. Does a Claude seat play worse with reasoning off? The switch makes the comparison possible; it has not been measured.
