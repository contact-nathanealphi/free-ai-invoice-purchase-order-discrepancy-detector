# AI Invoice & Purchase Order Discrepancy Detector

A free, **local-first**, **stateless** Accounts Payable (AP) audit and forensic discrepancy detection platform that combines **AI document extraction** (Google Gemini, OpenAI, Anthropic Claude, or **100% Offline Local AI via Ollama / LM Studio**) with a **deterministic 7-Gate mathematical validation engine** and **0-token local fraud analytics**.

All Purchase Orders, uploaded invoice PDFs/images, learned item aliases, audit policies, and audit logs remain privately in your browser's **IndexedDB** and can be backed up as an **AES-256-GCM encrypted `.auditvault`** file (also compatible with legacy `.exacta` / `.parivex` vault files).

---

## Key Capabilities

1. **Hybrid AI Extraction + 7-Gate Deterministic Audit Engine (`src/auditEngine.js`)**
   - **Token-Saver Hybrid Reader (`src/pdfMarkdownExtractor.js`)**: Converts digital PDFs into clean Markdown locally before AI extraction (~80% token savings), falling back to multimodal vision only for scans/images or when *Force Vision Mode* is enabled.
   - **7-Gate Verification Pipeline**:
     1. OCR Confidence Threshold (`< 0.85` → `HUMAN REVIEW`)
     2. SHA-256 File Hash Deduplication (`HOLD - DUPLICATE INVOICE`)
     3. PO Lookup & Status Guard (`OPEN` vs `CLOSED`)
     4. Currency Guard (`IDR`, `USD`, `SGD`, etc.)
     5. Dynamic Multi-Tax Engine (configurable PPN/VAT % & PPh 23 % for `SERVICE` POs)
     6. Line-Item Matching, Item Alias Dictionary, Forbidden Fee Blacklist & Price Variance Tolerance (`HOLD - UNORDERED ITEM` / `HOLD - PRICE VARIANCE`)
     7. 3-Way Warehouse GRN Match (`HOLD - GRN MISMATCH`)

2. **0-Token Local Forensic & Fraud Intelligence (`src/forensicEngine.js`)**
   - **Split-Invoicing Detector**: Flags multiple invoices from the same vendor within a configurable window just below approval thresholds whose combined total exceeds the limit.
   - **Vendor Price-Creep Memory**: Alerts when unit prices rise >3% above historical vendor medians.
   - **Fuzzy Duplicate Trap**: Catches slightly altered invoice numbers (Levenshtein distance <= 2) with matching vendor, amount (±1%), and date (±14 days).
   - **Chronology & Round-Number Anomalies**: Detects backdated invoices (`invoice_date < po_date`), weekend issuance, and repeated round-number billing.

3. **Omnivore Intake & Resolution-to-Payment Closure**
   - **Multi-Format Intake**: PDF, mobile photos (`JPG`/`PNG`/`WEBP`), raw pasted WhatsApp/Email text, **Quick 2-Doc Compare**, **Batch `.zip` Queue**, and **0-Token Bulk CSV PO Import**.
   - **1-Click Dispute Action Pack**: Generates formal dispute emails (Indonesian/English, 3 tones), WhatsApp messages, and printable **Official Debit Notes**.
   - **Accounting & Bank Exports**: Ready-to-import CSV presets for **Accurate Online**, **Mekari Jurnal.id**, **Xero**, **QuickBooks Online**, and **Batch Bank Transfer**.
   - **CFO Command Center**: Vendor Trust Score (0–100) Leaderboard, AP Aging & Cashflow Radar, Early Payment Discount (`2/10 Net 30`) alerts, and **Mark as Paid** (auto-closes linked POs).
   - **Tamper-Evident Evidence Pack & AES-256 Vault**: SHA-256 cryptographic fingerprints via Web Crypto API + `PBKDF2` + `AES-256-GCM` `.auditvault` export/import.
   - **Installable PWA**: Works offline via `manifest.json` + `sw.js` alongside Local Ollama (`http://localhost:11434/v1`).

---

## Quick Start

```bash
npm install
npm run build
npm run dev
```

Open `http://localhost:3000` in your browser. Run all unit & integration tests with:

```bash
npm test
```

## Deploy to Vercel

1. Push this repository to GitHub.
2. Import the repository in Vercel (Build Command: `npm run build`, Output Directory: `public` / root stateless serverless `api/*.js` via `vercel.json`).
3. Optionally set `GEMINI_API_KEY` in Vercel Environment Variables to enable the free 2/day server demo quota; users can also enter their own BYOK key or use Local Offline Ollama directly in the browser.
