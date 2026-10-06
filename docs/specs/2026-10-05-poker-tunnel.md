# Poker friends from any network (Cloudflare quick tunnel) — Design Spec

- **Date:** 2026-10-05
- **Status:** Built
- **Context:** It extends the [friends' table spec](2026-10-01-poker-friends-table.md), whose "Out" list deferred joining from outside the home network.

## Goal

A friend who is not on the host's Wi-Fi can still take a Friend seat, from any network, with the same private seat link.

## Decision: the seat link is the gate, for now

The friends' spec planned this step "behind a sign-in (OAuth)". This version ships without a sign-in: a quick tunnel needs no Cloudflare account, and the gate is the 192-bit seat key in each link, the same gate the home network already uses. That is acceptable for a play-chips game among friends. A real sign-in is possible later on your own Cloudflare zone (a named tunnel plus Cloudflare Access). That changes your Cloudflare account (a DNS record and an Access application), so it is built only on request. An existing `~/.cloudflared` setup is never read or changed.

## Scope

**In:**

- `openpoker --web --tunnel`: the table opens a Cloudflare quick tunnel (`cloudflared`, no account) and prints its `https://….trycloudflare.com` address. Friend seats are available with `--tunnel`, `--lan` or both.
- Invite links use the tunnel address when the tunnel is up, so one link works from anywhere, including the same Wi-Fi.
- The friend's page works through the tunnel, which holds back the server's event stream: the page notices and reads its seat's state every 1.5 seconds instead.

**Out:**

- A sign-in in front of the table (next, on request; see above).
- A fixed address. A quick tunnel gets a new random address each time the table starts, so links from an earlier start stop working, as seat keys already do.
- Restarting a tunnel that drops mid-game. The page shows that it dropped; a restart would get a new address and break every link anyway.
- The host's own page through the tunnel. The host uses the table on this computer.

## Acceptance criteria

- Given `--tunnel`, when cloudflared connects to the table, then it reaches a separate listener on `127.0.0.1` that treats every request as a guest's, whatever address it comes from; `cloudflared` is never pointed at the host's port.
- Given the guest listener, when anything asks for a host route (`/state`, `/new`, `/close`, `/personas`, `/games`, `/learner`, `/invites`, `/seats/…`, `/action`, `/next`), then it is refused, including a request from this computer.
- Given the guest listener, when a request names any host other than the tunnel's own hostname, or arrives before that hostname is known, then it is refused (403); a write whose `Origin` is not `https://<that hostname>` is refused too.
- Given a friend's link through the tunnel, when the friend opens it, then their seat plays exactly as on the home network: their own cards, showdown cards, their moves on their own clock, a wrong key refused (401).
- Given the tunnel holds back the event stream, when the friend's page gets no first notice within 4 seconds, then it closes the stream and reads `/guest/state` every 1.5 seconds, without showing "lost contact". On this computer and on the home network the first notice arrives at once and the page never polls.
- Given the table stops (Ctrl-C, the launch entry, or the process ending), then `cloudflared` stops with it.
- Given `cloudflared` is not installed or cannot open a tunnel within 60 seconds, then the table still starts on this computer and says why friends from other networks cannot join.

## Design

**Two listeners.** `startTableServer` keeps serving the host on its port, with the home-network rules unchanged. `startGuestServer` listens on `127.0.0.1` on a free port and answers only `GET /play` (a bare `GET /` is redirected there, since the page served at `/` would run as the host's), `GET /guest/state`, `POST /guest/action` and `POST /guest/next`, through the same code as the host's port; everything else is 404. It serves no event stream (since the 2026-10-06 security review): the quick tunnel holds the stream back anyway, the friend's page reads its state every 1.5 seconds, and nobody holding the address can tie up connections. It accepts exactly one `Host`, the tunnel's hostname, once `cloudflared` has printed it.

**The tunnel.** `src/tunnel.mjs` starts `cloudflared tunnel --config <temp file> --url http://127.0.0.1:<guest port>`. The temp file holds only `no-autoupdate: true`, so an existing `~/.cloudflared/config.yml` is not read. The address is read from `cloudflared`'s output. The child is stopped when the table stops and on process exit. If it exits on its own, `/state` says so and the Invite dialog stops offering tunnel links.

**What travels where.** The seat key stays in the link's `#key=` part, which browsers never send. The page sends it in the `X-Seat-Key` header; HTTPS ends at Cloudflare's edge, so Cloudflare carries that header, as it carries every request through a tunnel. Requests reach the guest listener from `cloudflared` on this computer.

## Constraints and risks

- Cloudflare documents quick tunnels as a way to try Tunnel: about 200 requests in flight, no uptime promise, and no event streams. Six friends polling every 1.5 seconds is about 4 requests a second.
- A new address can take a minute to resolve on some networks; this Mac's resolver took 78 seconds once, while `1.1.1.1` answered at once.
- Anyone with a link can play that seat until the table restarts. Share links privately.
- The host's computer must stay on and online for the game to go on.

## Verification

- Tests: the guest listener (host routes refused from loopback, host and origin checks, the page served, the stream cap), the tunnel start-up (address read, failure and time-out reported) with a stand-in `cloudflared`, and `--tunnel` needing `--web`.
- Live, 2026-10-05: a probe through a real quick tunnel arrived from `127.0.0.1` with `Cf-Connecting-Ip` set (why the guest listener exists), and the event stream delivered nothing in 8 seconds (why the page polls). The full check is recorded in the changelog.
