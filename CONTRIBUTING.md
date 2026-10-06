# Contributing

Thank you for helping. OpenPoker has no npm dependencies and needs Node.js 20 or newer.

```bash
npm run check    # syntax check of every module, then the full test suite
npm test         # the tests only
```

Before you send a change:

- Run `npm run check`; every test must pass.
- Keep it play chips only. Changes that connect to a poker site, handle real money, or automate play on someone else's service will not be accepted.
- A player, human or AI, may only ever play one of the legal moves the code lists. Keep model replies and agent notes as untrusted text.
- Anything that listens on a network or opens a tunnel needs a test showing what a guest can and cannot reach.
- For a change in behaviour, update the matching spec in `docs/specs/` and add a line to `CHANGELOG.md` under Unreleased.

By sending a contribution you confirm that you wrote it or have the right to give it. You keep your copyright, and you grant the licensor, Learn57130, a perpetual, worldwide, royalty-free and irrevocable license to use, change and distribute it under any terms: the PolyForm Noncommercial License 1.0.0 that the project uses, and the separate commercial licenses the licensor may offer.
