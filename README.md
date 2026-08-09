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
