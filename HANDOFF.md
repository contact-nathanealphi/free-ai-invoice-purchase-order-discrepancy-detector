# Session Handoff — Exacta (Automated Invoice vs. PO Discrepancy Detector)

## Status Proyek
- **v1–v2 (Core Deterministic Engine & Gemini Extractor):** Selesai & terverifikasi.
- **v3.0–v3.5 (Full-Stack Vercel + Supabase, 3-Way Match, Enterprise UI):** Selesai & terverifikasi.
- **v4.0 (Public Local-First, Token-Saver & Multi-Provider BYOK Edition):** Selesai & terverifikasi (`32/32` unit test PASS).

## File Aktif Utama
- **Core & AI:**
  - `src/auditEngine.js` — Deterministic 7-Gate AP Audit Engine (termasuk 3-Way Warehouse GRN Match `HOLD - GRN MISMATCH`).
  - `src/pdfMarkdownExtractor.js` — Hybrid PDF-to-Markdown reader (`pdf-parse/lib/pdf-parse.js`, routing `text_markdown` vs `multimodal_vision`).
  - `src/aiProviderAdapter.js` — Curated 3-Provider BYOK adapter (`gemini`, `openai`, `anthropic`) untuk Invoice & Purchase Order PDF.
  - `src/sampleCache.json` — Cache statis 0-token untuk 8 skenario `Sample Studio`.
  - `src/dbRepository.js` & `supabase/schema.sql` — Repository Supabase + fallback lokal `data/local_ledger.json` + 3 pre-seeded audit logs.
- **Serverless API (`api/`):**
  - `api/audit.js`, `api/extract-po.js`, `api/dashboard.js`, `api/pos.js`, `api/resolve.js`, `api/reset.js`, `src/apiHelpers.js`, `src/localServer.js`.
- **Frontend (`public/`):**
  - `public/workspaceStore.js` — Local-first `localStorage` state (`purchaseOrders`, `auditLogs`, BYOK config, Export/Import JSON).
  - `public/index.html` & `public/app.js` — **Exacta** Command Center (Pre-Flight Inspector, Batch PDF Intake, Audit Ledger + Filters, Split-Screen PDF & 7-Gate Modal, Export Report `.md` & Print PDF, BYOK 3-Provider Modal, Upload PO PDF).
  - `public/playground.html` & `public/playground.js` — **Exacta — Audit Sandbox & Sample Studio** (0-token Edge-Case Scenarios & `jsPDF` Custom Dummy Invoice Builder).

## Verifikasi Terakhir
- `node --test`: **32 pass, 0 fail, 0 skipped** (`tests/auditEngine.test.js`, `tests/auditEngineV2.test.js`, `tests/auditEngineV3.test.js`, `tests/auditEngineV4.test.js`, `tests/geminiExtractor.test.js`).
- `node --check` pada seluruh modul JS backend & frontend: exit code `0`.
- Server lokal berjalan di `http://localhost:3000`.

## Langkah Berikutnya
- Siap deploy ke Vercel (`vercel.json` sudah menyertakan `{prompts,src,test_data,test_data_wild}/**` dan `maxDuration: 30`).
- Opsional: isi `GEMINI_API_KEY` di environment Vercel untuk kuota demo server (2 upload/hari/IP) dan/atau `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` jika ingin mode cloud persisten.
