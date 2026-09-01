# Contributing to Clawdeck

Thanks for looking. Clawdeck is a small, deliberately-constrained local
tool, and the constraints are the point — a contribution that respects
them is much more likely to land.

## The hard rules

- **Zero runtime dependencies.** The server is Node stdlib only; the UI is
  browser-native ES modules with no build step. A PR that adds a runtime
  dependency will not be merged unless it removes a much larger problem
  than it introduces. Dev-only tooling (test, lint) is fine.
- **The security boundary is not negotiable.** Clawdeck binds loopback,
  refuses foreign `Host` headers, gates privileged routes behind the
  per-launch token, and has no arbitrary-command endpoint (only a fixed
  named-action allowlist with server-built argv). A new route or action
  must fit that model. See [`docs/SECURITY.md`](docs/SECURITY.md) and
  [`docs/DECISIONS.md`](docs/DECISIONS.md) before adding one.
- **Degrade, don't crash.** Adapters must fail their own section, not the
  whole snapshot. Follow the existing `catch`-to-fallback pattern.

## Running it

```bash
node scripts/panel-run.mjs --checkout /path/to/a/project   # start it
npm test                                                   # node --test
npm run self-test                                          # boots the server, checks /health
```

No install step for the tool itself; `npm install` only pulls the dev
toolchain.

## Sending a change

1. Open an issue first for anything non-trivial, so the design can be
   agreed before you build it.
2. Keep the change focused. One concern per PR.
3. Add or update tests. Security-relevant changes need a test that
   exercises the boundary against the real server (see
   `tests/panel-http-token.test.mjs` for the pattern).
4. `npm test` and `npm run self-test` must pass. CI runs both on Linux and
   Windows.

## Reporting a security issue

Please do **not** open a public issue for a vulnerability. Email
**contact@miguelsanchez.co.uk** with the details and a way to reproduce.
You will get a response before anything is disclosed publicly.

## Scope

Clawdeck watches Claude Code work locally. It is not a hosted service, a
multi-user server, or a general git dashboard, and it will stay that way.
Proposals that pull it toward any of those are likely out of scope — but
an issue describing the underlying need is always welcome.
