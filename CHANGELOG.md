# Changelog

All notable changes to this project are documented in this file.

## [6.0.0] - 2026-11-26

### Added
- **Enterprise Phase A — Governance & Fraud Prevention:**
  - Gate 6 Anti-BEC Vendor Master Bank Account & NPWP Guard (`HOLD - BANK ACCOUNT MISMATCH`, `HOLD - VENDOR BLOCKED`, `api/vendors.js`).
  - Maker-Checker RBAC (`AP_CLERK`, `FINANCE_MANAGER`, `CFO`, `AUDITOR`), Segregation of Duties (`SOD_VIOLATION`), multi-level `PENDING_CFO_APPROVAL` escalation (> Rp50M), and immutable append-only `audit_events` trail (`api/audit-events.js`).
  - Single Source of Truth `npm run build:n8n` generator (`scripts/buildN8n.js`) + GitHub Actions CI quality gate (`.github/workflows/ci.yml`).
- **Enterprise Phase B — Multi-Instance Serverless Scale:**
  - Distributed Upstash Redis REST rate limiter & daily demo quota (`INCR` + `EXPIRE`) with automatic in-memory fallback.
  - Transactional Postgres ACID RPC (`record_audit_and_deduct_po`) using `SELECT ... FOR UPDATE` row-level locking and idempotent `file_hash` verification.
  - Private Supabase Storage PDF offloading with time-limited Signed URLs (`src/storageRepository.js`).
- **Pro-Class Observability, UI & Documentation:**
  - `/api/health` readiness endpoint, structured JSON logger (`src/logger.js`) with `x-request-id` correlation IDs, OpenAPI 3.1 spec (`docs/openapi.yaml`), and Architecture Decision Records (`docs/ARCHITECTURE.md`).
  - Modular Enterprise UI drawers (`public/js/enterprisePanels.js`) for Vendor Master & Immutable Audit Events Timeline, plus Playwright E2E smoke test (`tests/e2e/dashboard.spec.js`).

### Security
- Closed split-line same-PO-item over-billing bypass inside a single invoice.
- Blocked `AUDITOR` and `AP_CLERK` RBAC tokens from mutating `/api/vendors`, `/api/pos`, and `/api/reset`.
- Hoisted local ledger mutex to module-level `Map` to eliminate concurrent HTTP lost-write races.
