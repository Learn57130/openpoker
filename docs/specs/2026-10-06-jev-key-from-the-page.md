# Jev key from the start screen — Design Spec

- **Date:** 2026-10-06
- **Status:** Built
- **Context:** The Jev player needs a TypeSafe API key. Until now the only ways to give one were the `TYPESAFE_API_KEY` environment variable or a `.env` file in the folder the table starts from. `openpoker doctor` showed that step as the main gap in setting up.

## Goal

A person who has a TypeSafe key can seat Jev without editing a file. They paste the key once on the start screen. The key stays on their own computer, and nothing that shows the table to anyone else ever carries it.

## Scope

**In:**

- On the host's start screen, a "Jev key" box. It appears when the chosen mode can seat Jev, and has three states:
  - **No key:** a password field, a "Remember on this computer" box and a "Use key" button.
  - **Key added here:** where the key lives, with a "Remove key" button.
  - **Key found elsewhere:** it says where (the environment, or which file). It offers "Remove key" only for the file this page saves to.
- Jev becomes available at once, without restarting the table, on every host page that is open.
- **Remember:**
  - Without it, the key lives only in the table's memory until the table stops.
  - With it, the key is saved for the next start: to the `--env-file` file when one is given, otherwise to `.env` in the data folder (`~/.openpoker/.env` by default).
- Every place that looks for the key also looks in that data-folder `.env`: the table, the terminal game and `openpoker doctor`.

**Out:**

- **Checking the key with TypeSafe when it is entered.** TypeSafe has no free check, and a test decision would spend the owner's usage without telling them. A wrong key shows on Jev's first move instead: the rule bot plays that move, and the table shows the error notice it already shows.
- **Typing a key from a friend's page or from another computer.**
- **Keys for any other tool.** Claude, Codex and OpenCode use their own sign-in.

## Order the key is looked for

1. A key added on the start screen during this run.
2. The `TYPESAFE_API_KEY` environment variable.
3. The `--env-file` file, when one is given. Otherwise:
   - `.env` in the folder the table starts from, then
   - `.env` in the data folder.

A key added on the page comes first, so a wrong key from a file can be replaced without editing the file.

## Acceptance criteria

- Given no key anywhere, when the host chooses a mode that can seat Jev, then the start screen shows the key box, Jev is listed as unavailable, and a game cannot seat Jev.
- Given the host pastes a key and presses "Use key", then Jev becomes available on the start screen at once, the field is emptied, and a game with Jev can be dealt.
- Given "Remember on this computer" is ticked, when the key is used:
  - it is written to the remember file, readable by the owner only (mode 600);
  - every other line in that file is kept;
  - an earlier `TYPESAFE_API_KEY` line there is replaced, not repeated.
- Given "Remove key", then:
  - the page key is dropped;
  - the line is deleted from the remember file and every other line there is kept;
  - Jev becomes unavailable again, unless a key remains in the environment or in another file. The box then says where that key is and that it cannot be removed from here.
- Given the remember file's place holds a symbolic link, when the key would be saved, then nothing is written and the page says so.
- Given any response the table sends (`/state`, `/jev-key`, the event stream, errors, the friend's state, `openpoker doctor`), then the key is not in it; the page learns only whether a key is set and where it lives.
- Given a key that is not 16 to 512 letters, digits or `. _ ~ + / = -` characters, then it is refused with a fixed message that does not repeat what was typed.
- Given a request to `/jev-key` from another computer (`--lan`), from the tunnel's guest listener, or from another website (a foreign `Origin`), then it is refused.

## Design

- **The key store, `src/jev-key.mjs`:**
  - The table, the terminal game and `doctor` share it.
  - It holds the page key in memory and reads the environment and the files each time it is asked. Jev's availability is refreshed whenever the start screen asks for the key status (when the page loads, and after any change), so a file edited while the table runs is picked up the next time the start screen loads.
  - It saves through a temporary file and a rename in the same folder.
  - It refuses a symbolic link.
- **Jev's player type:** `available` and `unavailable_reason` read the store each time they are asked. After a change the table bumps its version, so every host page redraws through its event stream.
- **The routes:** `GET`, `POST` and `DELETE /jev-key`. Like every other host route, they answer this computer only and refuse a foreign `Origin`. The tunnel's guest listener has no such route.
  - The key status is not part of `/state`, so it cannot reach a friend's view.
  - The status shows the home folder as `~`.
- **The page:**
  - The key field has `autocomplete="off"`.
  - The key is never kept in the page's storage.
  - The box is redrawn only when its own state changes, so a state ping cannot wipe a half-typed key.

## Constraints and risks

- **The key in transit:** a key typed into a page travels to the table over plain HTTP on the loopback interface. It never leaves this computer, and only this computer's own browser can reach the route.
- **A saved key on disk:** it sits in a file readable by the owner only, as a `.env` file written by hand would.
- **A wrong key:** it is found only on Jev's first move (see Out).
- **`--env-file` on Node 20:** Node 20 itself checks that a file named by `--env-file` exists, even after the script name, and stops with its own "not found" error before OpenPoker runs. On Node 20 that file must exist before the first start; an empty file is enough. Node 22 and later do not check it. In both, a key saved there is reported as coming from that file, and Remove key can take it out (checked on Node 20.20 and 22.18).

## Verification

- `tests/poker-jev-key.test.mjs` covers the store and runs real tables:
  - the lookup order, the remember file and its mode, other lines kept, removal, and a refused link;
  - Jev turning available and back;
  - a game dealt with Jev;
  - the fake key absent from every response and from `doctor`;
  - refusals from another computer, from the guest listener and from a foreign origin.
- **In the browser:** I checked the start screen against a table with no key, using a made-up key.
