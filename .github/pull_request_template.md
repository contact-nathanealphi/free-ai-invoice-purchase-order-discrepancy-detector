## Summary
- Describe what changed and why.

## Verification Checklist
- [ ] `npm run build:n8n -- --check` passes (zero drift)
- [ ] `node --test` passes 100%
- [ ] `npm run benchmark:mock` passes 10/10
- [ ] `npm run build` succeeds
- [ ] No secrets, `.env`, or local runtime artifacts included in diff
