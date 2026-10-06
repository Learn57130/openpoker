# Security

OpenPoker is a local play-chips game. It never connects to a poker site and never handles real money.

## What the table exposes

- **The deal.** Games people play are dealt from the operating system's secure random generator, so no player can work out the deck from the cards they see. A repeatable seed is used only for measurements (`--auto`), tests and an explicit `--seed`, and `--seed` is refused together with `--lan` or `--tunnel`.
- **Default (`openpoker --web`).** The server listens on `127.0.0.1` only. Requests must name a local host (`127.0.0.1` or `localhost`), and writes from other sites are refused.
- **`--lan`.** The server also listens on your home network. A request from another computer may reach only the friend's page, the change notices, and the `/guest/*` routes with that seat's key (a 192-bit random secret, compared in constant time, replaced when someone else takes the seat). Everything else answers 403. At most 50 change-notice streams from other computers are open at once. Plain HTTP: fine on a home network you trust, not on a public one.
- **`--tunnel`.** A Cloudflare quick tunnel forwards internet requests to a separate guest-only listener on `127.0.0.1`. That listener treats every request as a guest's, accepts only the tunnel's host name and HTTPS origin, and answers only the friend's page and `/guest/*` by seat key; every host route, and the change-notice stream, answers 404 there. HTTPS ends at Cloudflare's edge, so Cloudflare carries the requests, including the seat key header. The private link is the only gate: anyone holding a link can play that seat until someone else takes it or the table restarts.
- **The page.** It may not be shown inside another site (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), and it inserts every name, note and reply as text, never as HTML. Errors inside the table answer with a plain message, not internals. A friend's page shows only the player types at their table, nothing of the host's installed tools or add-ons, and the open-seat route shows nothing of a friend's cards.
- **AI players.** The Claude, Codex and OpenCode players run those command-line tools with your own signed-in accounts, in an empty temporary folder, in their read-only or planning modes. Their replies are treated as untrusted text: only one of the code-listed legal moves is ever played.
- **Your files.** Saved games, personas and policies are written with mode 0600 in 0700 folders under `~/.openpoker/`. Game logs hold every player's cards and AI replies; keep them private if that matters to you.

## Reporting a problem

Please report a security problem privately through GitHub's "Report a vulnerability" (Security → Advisories) on this repository rather than in a public issue. Include what you did, what happened, and what you expected.
