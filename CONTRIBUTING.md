# Contributing

Thank you for contributing to **AI Invoice & PO Discrepancy Detector**.

## Development Workflow

```bash
npm install
npm run build
npm run build:n8n -- --check
npm test
npm run benchmark:mock
```

## Core Rules

1. **Single Source of Truth:** All deterministic audit logic lives in `src/auditEngine.js`. Whenever you modify it, run `npm run build:n8n` to regenerate `src/n8nCodeNodeTemplate.js` and sync `workflows/invoice_po_audit_n8n.json`. CI will fail if drift is detected.
2. **Zero-Regression Tests:** Every bug fix or financial rule change must include a regression test in `tests/` (`node --test`).
3. **Security Hygiene:** Never commit `.env`, API keys, service-role keys, or local ledger dumps. Follow Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`).
