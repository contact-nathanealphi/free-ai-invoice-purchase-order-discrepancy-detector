# AI Invoice & Purchase Order Discrepancy Detector

An enterprise-grade Accounts Payable (AP) audit, fraud-prevention, and 3-Way Match platform that pairs **Hybrid AI Document Extraction** (Google Gemini, OpenAI, Anthropic Claude, or **100% Offline Local AI via Ollama / LM Studio**) with a **6-Gate Deterministic Audit Engine**, **0-Token Forensic Analytics**, **Maker-Checker RBAC Governance**, and **Multi-Instance Serverless Persistence**.

Designed to run either **Zero-Config Local-First** (private browser IndexedDB + AES-256-GCM `.auditvault` backup) or as a **Multi-Instance Enterprise Cloud Deployment** (Supabase Postgres ACID RPC + Private Object Storage Signed URLs + Upstash Redis Distributed Rate Limiting).

---

## Architecture Overview

### 1. Hybrid AI Extraction Pipeline (`src/pdfMarkdownExtractor.js`, `src/aiProviderAdapter.js`)
- **Token-Saver Hybrid Reader:** Converts digital PDFs into clean Markdown locally before LLM extraction (~80% token reduction), automatically falling back to Multimodal Vision only for scanned documents/images (`JPG`/`PNG`/`WEBP`) or *Force Vision Mode*.
- **Prompt-Injection Defense & Resilience:** Enforces strict JSON schema extraction (`src/invoiceSchema.json`), ignores embedded document override instructions, sends API keys via headers (`x-goog-api-key`), and includes 25s timeouts, exponential backoff, and automatic fallback models.
- **Omnivore Intake:** Supports PDFs, mobile photos, pasted WhatsApp/Email text, **Quick 2-Doc Compare**, **Batch `.zip` Queue** (with zip-bomb protection), and **0-Token Bulk CSV PO Import**.

### 2. 6-Gate Deterministic Audit Engine (`src/auditEngine.js`)
Zero LLM hallucinations on financial math — every invoice passes through deterministic, auditable gates:
1. **Gate 1 — OCR Confidence Calibration:** Flags blurry/noisy scans (`< 0.85` or OCR degradation signals) to `HUMAN REVIEW`.
2. **Gate 2 — Cryptographic & Business Deduplication:** Blocks duplicate billing via SHA-256 `file_hash` and `(invoice_number, vendor_name)` (`HOLD - DUPLICATE`).
3. **Gate 3 & 3B — PO Validation & Currency Guard:** Normalizes PO numbers, verifies `OPEN` status, and enforces strict currency matching (`IDR`, `USD`, `SGD`) (`HOLD - INVALID PO` / `HOLD - CURRENCY MISMATCH`).
4. **Gate 4 — Deterministic Multi-Tax & Subtotal Engine:** Recomputes line totals, printed `subtotal`, configurable PPN/VAT %, and `SERVICE` PPh 23 withholding (`HOLD - TAX ERROR`).
5. **Gate 5 & 5B — Multi-Item Matching, Split-Line Over-Billing Guard & 3-Way GRN Match:** Validates line items with token-boundary matching, item alias dictionary, forbidden fee blacklist, cumulative split-line quantity tracking across lines of the same invoice, remaining PO balance, and warehouse GRN received quantities (`HOLD - UNORDERED ITEM` / `HOLD - PRICE VARIANCE` / `HOLD - GRN MISMATCH` / `APPROVED - PARTIAL`).
6. **Gate 6 — Vendor Master Anti-BEC Bank Account & NPWP Fraud Guard:** Cross-checks invoice transfer bank accounts against `vendor_master` (`HOLD - BANK ACCOUNT MISMATCH`, hard-blocked and never overridable by `autoApproveCeiling`), blocks `SUSPENDED`/`BLOCKED` vendors (`HOLD - VENDOR BLOCKED`), and flags NPWP mismatches to `HUMAN REVIEW`.

### 3. 0-Token Forensic & CFO Intelligence (`src/forensicEngine.js`)
- **Split-Invoicing Detector:** Flags multiple vendor invoices within a rolling window below approval thresholds whose combined total exceeds the limit.
- **Vendor Price-Creep Memory:** Alerts when unit prices exceed historical vendor medians by >3%.
- **Fuzzy Duplicate Trap:** Detects near-duplicate invoice numbers (Levenshtein distance `<= 2`) with matching vendor, amount (±1%), and date (±14 days).
- **Resolution & ERP Exports:** 1-Click Dispute Action Pack (ID/EN emails, WhatsApp, XSS-safe Debit Note HTML), CSV formula-injection-safe exports (**Accurate Online**, **Mekari Jurnal.id**, **Xero**, **QuickBooks**, **Batch Bank Transfer**), AP Aging, and Vendor Trust Scores.

### 4. Enterprise Governance & Multi-Instance Scale (Phase A & Phase B)
- **Maker-Checker RBAC & Segregation of Duties (`src/apiHelpers.js`, `api/resolve.js`):** Supports `AP_CLERK`, `FINANCE_MANAGER` (≤ Rp50M), `CFO` (> Rp50M), and read-only `AUDITOR` roles via `RBAC_TOKENS_JSON`. Prevents Makers from self-approving (`403 SOD_VIOLATION`), blocks read-only/clerk mutations on `/api/vendors`, `/api/pos`, `/api/reset`, and escalates high-value invoices to `PENDING_CFO_APPROVAL`.
- **Immutable `audit_events` Trail (`supabase/schema.sql`, `api/audit-events.js`):** Append-only event ledger recording `actor_id`, `actor_role`, `action`, `previous_status`, `next_status`, `reason`, `ip_address`, and `created_at` on every creation and resolution.
- **Transactional Postgres ACID RPC (`record_audit_and_deduct_po`):** Uses `SELECT ... FOR UPDATE` row-level locking on `purchase_orders` to re-verify `file_hash` idempotency, deduct `remaining_qty`, insert `audit_logs`, and append `audit_events` atomically (with safe fallback + module-level `ledgerMutex` in local mode).
- **Private Object Storage & Signed URLs (`src/storageRepository.js`):** Offloads invoice PDFs to private Supabase Storage (`AUDIT_STORAGE_BUCKET`) with time-limited Signed URLs so database JSONB stays lean, with `local-inline-ephemeral` fallback locally.
- **Distributed Rate Limiting (`src/apiHelpers.js`):** Atomic `INCR` + `EXPIRE` via Upstash Redis REST API (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`), with automatic in-memory fallback.
- **n8n Single Source of Truth & CI (`scripts/buildN8n.js`, `.github/workflows/ci.yml`):** `npm run build:n8n` generates `src/n8nCodeNodeTemplate.js` and syncs `workflows/invoice_po_audit_n8n.json` directly from `src/auditEngine.js`, enforced in GitHub Actions via `--check`.

---

## Verified Benchmarks & Enterprise Superstress Results

| Verification Suite | Command / Runner | Result | Measured Metrics |
| :--- | :--- | :--- | :--- |
| **Unit, Security & Enterprise Regression** | `node --test` | **79/79 PASS (100%)** | 0 fail (~527ms); covers Gates 1–6, RBAC/SoD, Anti-BEC, Split-Line, Upstash Redis, ACID RPC, Storage Signed URLs, XSS/CSV hardening |
| **Clean E2E Benchmark** | `npm run benchmark:mock` | **10/10 MATCH (100%)** | 0 mismatch across standard AP scenarios |
| **Wild Chaos Stress Test v2** | `node src/runStressTest.js --mock` | **8/8 PASS (100%)** | Multi-item, sneaky fee, PPh 23 service, messy format, blurry scan, partial delivery, prompt injection, currency mismatch |
| **Enterprise Superstress & Red-Team** | 5,000-invoice throughput + 40 parallel HTTP requests | **9/9 PASS (100%)** | **~44,281 invoices/sec** (5,000 audits in `112.9ms`, `p95 = 0.047ms`, `p99 = 0.071ms`); 500-log forensic scan `7.27ms`; 40 concurrent HTTP requests (`0` errors, `10/10` concurrent writes persisted); RBAC escalation & path traversal blocked |
| **n8n Single Source of Truth & CI** | `npm run build:n8n -- --check` | **PASS (Zero Drift)** | Enforced automatically on push/PR via `.github/workflows/ci.yml` |

---

## Quick Start (Local Development)

```bash
npm install
npm run build
npm run build:n8n -- --check
npm test
npm run dev
```

Open `http://localhost:3000`.

---

## Deployment Modes & Environment Variables

Copy `.env.example` to `.env` for local configuration, or set variables in Vercel Project Settings:

### Mode 1 — Zero-Config Local-First (Serverless Stateless)
Deploy directly to Vercel (`npm run build` + `api/*.js` via `vercel.json`). No database required — users store data in encrypted browser IndexedDB/Vault and can supply their own BYOK key or run Local Ollama.
- `GEMINI_API_KEY` *(optional)*: Enables the server's free daily demo quota (2 custom documents/day/IP).
- `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` *(optional)*: Primary and automatic fallback Gemini models.

### Mode 2 — Full Enterprise Multi-Instance (Production Scale)
Apply `supabase/schema.sql` (creates `purchase_orders`, `audit_logs`, `vendor_master`, `audit_events`, RLS policies, and the `record_audit_and_deduct_po` ACID RPC) and configure:

| Variable | Purpose |
| :--- | :--- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Postgres persistence, RLS-protected service access, ACID PO deduction RPC, and Private Storage |
| `AUDIT_STORAGE_BUCKET`, `AUDIT_SIGNED_URL_TTL_SECONDS` | Private bucket name (default `invoice-pdfs`) and Signed URL expiry in seconds (default `900`) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Distributed atomic `INCR` + `EXPIRE` rate limiting & demo quota across serverless instances |
| `ADMIN_API_TOKEN` | Master bearer/`x-admin-token` secret protecting admin endpoints |
| `RBAC_TOKENS_JSON` | Role-scoped bearer token map, e.g. `{"tok-cfo":{"actor_id":"cfo@corp.id","role":"CFO"}}` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origin allowlist for production browsers |
