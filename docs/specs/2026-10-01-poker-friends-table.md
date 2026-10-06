# Poker friends' table on the home network — Design Spec

- **Date:** 2026-10-01
- **Status:** Built
- **Context:** It extends the [seats, models and clock spec](2026-09-30-poker-seats-models-clock.md).

## Goal

Friends on the host's Wi-Fi sit at the same table from their own phones or laptops, each seeing only their own cards, next to the host, bots and the AI players. Every game is saved with every player's cards, so the Learner learns from it like any other game; more people means far more hands to learn from than the host can play alone.

## Scope

**In:**

- `openpoker --web --lan`: the table also listens on the home network. Without `--lan` nothing changes: it answers only this computer.
- **Friend** seats: a person at any seat, named by the host, who plays from a private seat link.
- **Seat links:** `http://<this computer's address>:<port>/play#key=<seat key>`, one per seat, shown on the host's page with a copy button. The key is a 192-bit random secret. A seat keeps its key while the same friend (by name) sits there, so "Deal again" needs no new link, and gets a new one when anyone else does or the table restarts (since the 2026-10-06 security review, an old link opened the same seat for the next person).
- **The friend's page:** the same table, drawn from the friend's own seat at the bottom, with their own cards, the moves, the clock and the result; no game controls.
- **A "Friends" mode** on the start screen: the host or a friend in the first seat, then friends, bots and AI players.
- **Learning:** friends' games are saved with every player's cards and learned from like any other game.

**Out:**

- Joining from outside the home network. That comes next, behind a sign-in (OAuth) in front of the table; the per-seat keys are built so a sign-in can be tied to them. (Built on 2026-10-05 without the sign-in, through a Cloudflare quick tunnel: see the [friends from any network spec](2026-10-05-poker-tunnel.md).)
- Accounts, passwords, chat, avatars, saved friends, friend personas.
- A friend starting, closing or changing a game; the host's page does that. (Since 2026-10-05 a friend may deal the next hand at a table where the host has no seat; see below.)
- Real money, as everywhere in this game.

## Acceptance criteria

- Given the table started without `--lan`, when another computer connects, then it cannot (the server listens on this computer only), and the Friend player is unavailable.
- Given `--lan`, when another computer asks for any address other than the friend's page, the event stream, its seat's state or its seat's action, then it is refused (403); only this computer can start, close or set up games, see `/state`, use personas, history or training, or play an open seat.
- Given a request with no seat key or a wrong one, when it asks for a seat's state or action, then it is refused (401), and nothing tells it which keys exist.
- Given a friend's state, when it is read, then it shows that friend's own cards and, after a showdown, the cards shown there, and never another player's cards, hand strength or Jev's reasoning before then; the friend's seat is drawn as seat 0.
- Given a friend's state, when it is read, then it holds nothing from which the deck could be rebuilt (the game's random seed is replaced by a game number) and nothing that is the host's alone: no style notes to other seats, no warnings or error details from the host's computer, no account or model details of the host's AI tools.
- Given a friend's turn, when the friend sends a legal move with the right key, then it is played; a move that is not legal, or not their turn, is refused; the turn clock applies as for every seat.
- Given the host's page, when friends are seated, then the friends' cards are hidden there until a showdown, even when the host is only watching.
- Given a finished game with friends, when the game history reads it, then the history shows a friend's cards only where the table showed them.

## Design

**Who may do what.** A request from this computer (loopback) is the host: everything works as before. A request from any other address may only `GET /play` (the page), `GET /events` (the change notices, which carry only a counter), `GET /guest/state` and `POST /guest/action`. The guest routes need the header `X-Seat-Key`; the page reads the key from the link's `#key=` part, which browsers never send to a server or put in a referrer, so the key stays out of logs. Keys are compared in constant time. With `--lan` the server listens on all IPv4 interfaces and accepts the `Host` names of this computer's network addresses and its `.local` name; other names are still refused (DNS rebinding), and a POST from another site is still refused by the Origin check.

**Friend seats.** `{ type: "friend", name }` in `POST /new` (or `friend` in `--players`, named "Friend 1", "Friend 2"…). A friend seat waits for its move the way an open seat does, but only through the guest route with that seat's key; the open-seat protocol cannot play it. `GET /invites` (host only) lists each friend seat with its link.

**The friend's view.** `guestSnapshot(seat)` builds the state from the friend's side: their own cards, showdown cards only, hand names only where cards are visible, no decision reasoning (hand strength, odds words, probabilities), no file paths. The game's seed, which decides the shuffle, is replaced by the game's number: with the seed and the engine anyone could rebuild every hand (a review caught this before release). Style notes, warnings, error details and the host's player-type details (why a tool is unavailable, its model list) are left out too; the person running the table appears as "Host". Every seat number in it is turned so that the friend's seat is 0, which lets the same page draw it unchanged with the friend at the bottom. Its status is `your_turn` when that seat is to act.

**The friend's page.** `/play` serves the same page, which switches to guest mode: it reads `/guest/state` with the key, sends moves to `/guest/action`, and hides the start screen and the host's buttons. When a hand is over it says the host deals the next one.

**The host's page.** A "Friends" mode, a name box for each friend seat, and an "Invite" dialog (opened after dealing and from the header) with each seat's link and a copy button.

**Host without a seat** (added 2026-10-05). On the Friends' table, seat 0 may be a Friend instead of You; the host then only watches, with friends' cards hidden until a showdown. With no seat for the host nobody on the host's side deals, so each friend's state carries `guest.can_deal`, their page shows **Deal next hand** (and Enter) when a hand is over, and `POST /guest/next` with their key deals it. A second press after the hand is dealt is ignored. With the host seated the route answers 403 `HOST_DEALS`. Verified: `tests/poker-friends.test.mjs`, and live in the browser a friend in seat 0 played a hand against Claude Haiku and dealt the next one from their own page.

**Learning and history.** Friend seats are a person's seats: they are in the match log with their cards, and the game-history card rule hides a friend's cards except at a showdown.

## Constraints and risks

- Anyone on the same Wi-Fi who gets a link can play that seat until the table restarts. Share links privately; restarting the table makes new keys.
- The home network is not encrypted by this server (plain HTTP). That is acceptable at home; going beyond it needs the sign-in and an encrypted tunnel.
- The host's computer must stay awake and on the network for the game to go on.
- `--lan` listens on every interface, so a private network such as Tailscale (a `100.x` address) can reach the table too; only its signed-in members can, and they still need a seat link. Invite links use a home-network address (10.x, 172.16–31.x or 192.168.x) first.

## Open questions

- None for this step. Next: a sign-in (OAuth) gate and a tunnel for friends on other networks.
