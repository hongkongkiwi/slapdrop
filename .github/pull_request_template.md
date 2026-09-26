## Summary

<!-- What changed and why? -->

## Verification

- [ ] Added or updated focused tests where behavior changed.
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`

## Operational impact

- [ ] No D1 migration is needed, or the new migration was tested locally.
- [ ] No direct-upload contract changed, or `If-None-Match: *` behavior is covered by tests.
- [ ] No `/upload` CORS/custom-domain change is needed, or `docs/r2-cors.json` and the runbook were updated.
- [ ] No secret, API token, `.dev.vars*`, or generated Wrangler state is included.
