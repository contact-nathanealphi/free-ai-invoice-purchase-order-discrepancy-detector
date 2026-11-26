# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `6.x` (`main`) | Yes |
| `< 6.0` | No |

## Threat Model & Built-In Controls

This platform processes sensitive Accounts Payable (AP) financial documents and enforces defense-in-depth across every layer:

1. **Anti-BEC Bank Fraud Guard (Gate 6):** Compares invoice transfer bank accounts against `vendor_master`. Mismatches trigger a hard `HOLD - BANK ACCOUNT MISMATCH` that cannot be bypassed by `autoApproveCeiling`.
2. **Prompt-Injection Defense:** Extraction prompts treat PDF/image content strictly as untrusted data, and all financial math, tax rules, split-line quantities, and GRN limits are enforced deterministically outside the LLM (`src/auditEngine.js`).
3. **Maker-Checker RBAC & SoD:** Role-scoped bearer tokens (`RBAC_TOKENS_JSON`) enforce `AP_CLERK`, `FINANCE_MANAGER` (≤ Rp50M), `CFO` (> Rp50M), and read-only `AUDITOR` permissions with timing-safe token comparison and self-approval blocking (`SOD_VIOLATION`).
4. **Database & Storage Isolation:** Row Level Security (RLS) restricts Postgres tables to `service_role` only; PDFs are offloaded to private Supabase Storage with short-lived Signed URLs (`AUDIT_SIGNED_URL_TTL_SECONDS`).
5. **Frontend & Export Hardening:** Strict CSP/security headers (`vercel.json`), HTML escaping on Debit Notes (XSS prevention), CSV formula-injection neutralization, 15MB request body cap, and 10MB/50MB zip-bomb guards.

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities. Report privately via GitHub Security Advisories or email the maintainer with reproduction steps and impact assessment. You will receive an initial response within 72 hours.
