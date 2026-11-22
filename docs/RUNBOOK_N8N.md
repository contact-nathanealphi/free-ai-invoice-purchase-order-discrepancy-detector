# Operational Runbook: n8n Automated Invoice vs. PO Audit Workflow

This runbook explains how to set up Google Sheets, import the n8n workflow blueprint, configure credentials, and verify end-to-end execution using the provided test invoices.

---

## 1. Google Sheets Setup (`Finance_AP_System`)

Create a new Google Spreadsheet named **`Finance_AP_System`** with three tabs:

### Tab 1: `Master_PO`
Import [`test_data/Master_PO.csv`](../test_data/Master_PO.csv) directly into this tab (Row 1 as headers). Expected columns:
`po_number`, `vendor_name`, `item_name`, `qty`, `unit_price`, `expected_subtotal`, `expected_tax_11`, `expected_total`, `status`

### Tab 2: `Invoice_Audit_Log`
Create Row 1 with the following exact header columns:
`invoice_number` | `po_number` | `vendor_name` | `invoiced_total` | `po_total` | `variance` | `confidence_score` | `audit_status` | `discrepancy_reason` | `requires_human_review` | `checked_rules` | `audited_at`

### Tab 3: `Human_Review_Queue`
Create Row 1 with the following exact header columns:
`invoice_number` | `po_number` | `vendor_name` | `invoiced_total` | `confidence_score` | `audit_status` | `discrepancy_reason` | `requires_human_review` | `checked_rules` | `queued_at`

> **Tip:** Copy the Spreadsheet ID from the URL (`https://docs.google.com/spreadsheets/d/<YOUR_GOOGLE_SHEET_DOCUMENT_ID>/edit`) — you will paste it into the Google Sheets nodes in Step 3.

---

## 2. Import Workflow into Local n8n

Start n8n locally from any terminal:

```bash
npx n8n
```

1. Open the n8n UI in your browser (default: `http://localhost:5678`).
2. Click **Create Workflow** -> open the top-right menu (`...`) -> **Import from File**.
3. Select [`workflows/invoice_po_audit_n8n.json`](../workflows/invoice_po_audit_n8n.json).

---

## 3. Configure the 3 Credential Placeholders

Before activating the workflow, replace the placeholder credentials and IDs in the imported nodes:

1. **Gemini API Key (`HTTP Request - Gemini Extraction` node)**
   - Locate Header `x-goog-api-key` and replace `YOUR_GEMINI_API_KEY` with your Google AI Studio API key (or bind an n8n Header Auth credential).
   - Endpoint used: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`.
2. **Google Sheets OAuth2 (`Read Master_PO`, `Read Invoice_Audit_Log`, `Append Invoice_Audit_Log (Approved)`, `Append Human_Review_Queue`, `Append Invoice_Audit_Log (Hold)` nodes)**
   - Connect your Google Sheets OAuth2 credential in n8n.
   - Replace `YOUR_GOOGLE_SHEET_DOCUMENT_ID` with the Spreadsheet ID of `Finance_AP_System`.
3. **Finance Manager Alert (`Alert Finance Manager (Human Review)` & `Alert Finance Manager (Discrepancy Hold)` nodes)**
   - Connect an SMTP / Gmail credential (or swap the node for a **Telegram** / **Slack** node) and replace `finance-manager@example.com` with the recipient address.

---

## 4. Verification Procedure

Click **Test Workflow** (or open the Production/Test Form URL from the `n8n Form Trigger` node) and upload two test PDFs sequentially:

1. **Normal Case (`test_data/invoices/INV_01_normal_nusantara.pdf`)**
   - **Expected Route:** Output 0 (`APPROVED`)
   - **Expected Behavior:** Row appended to `Invoice_Audit_Log` with `audit_status = APPROVED`, `variance = 0`, `requires_human_review = false`. No alert sent to Finance Manager.
2. **Trap / Anomaly Case (`test_data/invoices/INV_08_tax_error_sentosa.pdf`)**
   - **Expected Route:** Output 2 (`HOLD - *`)
   - **Expected Behavior:** Row appended to `Invoice_Audit_Log` with `audit_status = HOLD - TAX ERROR`, `variance = 500000`, `requires_human_review = true`, plus a detailed discrepancy alert sent to the Finance Manager.
3. **Optional Duplicate & Low-Confidence Checks**
   - Re-upload `INV_09_duplicate_nusantara_copy.pdf` after `INV_01` is logged -> routes to `HOLD - DUPLICATE`.
   - Upload `INV_10_low_confidence_kemasan.pdf` -> routes to `HUMAN REVIEW` and appends to `Human_Review_Queue`.
