# Botyard browser lease action

This Node 24 GitHub Action acquires one disposable Chromium browser from
Botyard, exports a masked `BOTYARD_CDP_URL`, and releases and purges the browser
in its post step.

Pin the action to a full commit SHA:

```yaml
- uses: ak5/botyard-browser-action@<full-commit-sha>
  with:
    api-url: ${{ vars.BOTYARD_API_URL }}
    api-key: ${{ secrets.BOTYARD_API_KEY }}
    ttl-minutes: 30

- run: pnpm test:e2e:serial-browser
```

The API key must have the narrow `browser:lease` capability. The action masks
the key and signed CDP attachment, and its hard lease TTL reclaims the browser
if GitHub cannot run the post step.

Creation retries reuse one random idempotency key per action invocation. Startup
polling obeys the earlier of the server startup deadline and lease expiry, and
requests time out after at most 15 seconds. The post step never acquires a browser,
including after failed setup. When no lease ID was recovered, hard TTL reclaims
any lease whose creation response was lost.

Use one Playwright worker per lease and connect with
`playwright.chromium.connectOverCDP(process.env.BOTYARD_CDP_URL)`. Playwright runs
on the CI runner; this action does not install or launch a local browser. Target
URLs must be reachable from the remote browser: CI-runner `localhost` is not a
remote application route.

The action implementation and regression tests are maintained in Botyard's
`actions/browser-lease` directory and copied here for separate, SHA-pinned
releases. This repository checks Node 24 behavior before merging releases.
