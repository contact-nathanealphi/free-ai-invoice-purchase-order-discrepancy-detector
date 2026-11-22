-- Automated Invoice vs. PO Discrepancy Detector (v3)
-- PostgreSQL / Supabase Schema & Initial Seed Data

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Master Purchase Orders (with JSONB line items & 3-Way Match GRN quantities)
CREATE TABLE IF NOT EXISTS purchase_orders (
  po_number TEXT PRIMARY KEY,
  vendor_name TEXT NOT NULL,
  po_type TEXT NOT NULL DEFAULT 'GOODS' CHECK (po_type IN ('GOODS', 'SERVICE')),
  currency TEXT NOT NULL DEFAULT 'IDR',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Immutable Audit Logs & Human-in-the-Loop Resolution Ledger
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  file_name TEXT,
  file_hash TEXT,
  invoice_number TEXT,
  po_number TEXT,
  vendor_name TEXT,
  currency TEXT NOT NULL DEFAULT 'IDR',
  grand_total NUMERIC(18, 2),
  audit_status TEXT NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  extraction_data JSONB,
  po_snapshot JSONB,
  model_used TEXT,
  latency_ms INTEGER,
  cost_idr NUMERIC(12, 2) DEFAULT 0,
  reviewer_action TEXT,
  reviewer_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_file_hash ON audit_logs (file_hash);
CREATE INDEX IF NOT EXISTS idx_audit_logs_po_number ON audit_logs (po_number);
CREATE INDEX IF NOT EXISTS idx_audit_logs_status ON audit_logs (audit_status);

-- 3. Seed Data: Wild Master PO (test_data_wild/Wild_Master_PO.csv)
-- Inserted first so multi-item, SERVICE PPh 23, partial delivery, and currency scenarios match cleanly.
INSERT INTO purchase_orders (po_number, vendor_name, po_type, currency, items, status)
VALUES
  (
    'PO-2026-001',
    'PT Andalan Perkakas Nusantara',
    'GOODS',
    'IDR',
    '[{"item_name":"Mesin Bor Industri Heavy Duty","qty":3,"unit_price":2000000,"remaining_qty":3,"grn_received_qty":3}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-002',
    'CV Karya Mandiri Logistik',
    'GOODS',
    'IDR',
    '[{"item_name":"Pallet Plastik Industrial 120x100 cm","qty":5,"unit_price":1200000,"remaining_qty":5,"grn_received_qty":5}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-003',
    'PT Konsultan Digital Prima',
    'SERVICE',
    'IDR',
    '[{"item_name":"Jasa Audit Keamanan Sistem & Infrastruktur Cloud","qty":1,"unit_price":10000000,"remaining_qty":1,"grn_received_qty":1}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-004',
    'PT Graha Suplai Kantor',
    'GOODS',
    'IDR',
    '[
      {"item_name":"Kertas A4 80gsm (Box 5 Rim)","qty":20,"unit_price":250000,"remaining_qty":20,"grn_received_qty":20},
      {"item_name":"Toner LaserJet Black Original","qty":4,"unit_price":1250000,"remaining_qty":4,"grn_received_qty":4},
      {"item_name":"Kursi Kerja Ergonomis Mesh","qty":2,"unit_price":2250000,"remaining_qty":2,"grn_received_qty":2},
      {"item_name":"UPS APC 1100VA Backup Power","qty":3,"unit_price":1500000,"remaining_qty":3,"grn_received_qty":3}
    ]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-005',
    'PT Sentra Komponen Elektronik',
    'GOODS',
    'IDR',
    '[{"item_name":"Barcode Scanner Wireless 2D","qty":10,"unit_price":1500000,"remaining_qty":10,"grn_received_qty":6}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-006',
    'PT Global Teknologi Niaga',
    'GOODS',
    'IDR',
    '[{"item_name":"Switch Gigabit Managed 24-Port","qty":4,"unit_price":2000000,"remaining_qty":4,"grn_received_qty":4}]'::jsonb,
    'OPEN'
  )
ON CONFLICT (po_number) DO NOTHING;

-- 4. Seed Data: Standard Master PO (test_data/Master_PO.csv)
INSERT INTO purchase_orders (po_number, vendor_name, po_type, currency, items, status)
VALUES
  (
    'PO-2026-001',
    'PT Nusantara Logistik',
    'GOODS',
    'IDR',
    '[{"item_name":"Sewa Armada Truk Box Engkel (Jakarta-Surabaya)","qty":4,"unit_price":4500000,"remaining_qty":4,"grn_received_qty":4}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-002',
    'CV Teknologi Kantor',
    'GOODS',
    'IDR',
    '[{"item_name":"Lisensi Software Akuntansi Enterprise (Tahunan)","qty":10,"unit_price":2500000,"remaining_qty":10,"grn_received_qty":10}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-003',
    'PT Sumber Kemasan',
    'GOODS',
    'IDR',
    '[{"item_name":"Kardus Corrugated Double Wall 60x40x40 cm","qty":2000,"unit_price":18500,"remaining_qty":2000,"grn_received_qty":2000}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-004',
    'PT Mitra Baja Mandiri',
    'GOODS',
    'IDR',
    '[{"item_name":"Rak Gudang Heavy Duty 4 Susun (Kapasitas 2 Ton)","qty":12,"unit_price":3200000,"remaining_qty":12,"grn_received_qty":12}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-005',
    'PT Solusi Cloud Nusantara',
    'GOODS',
    'IDR',
    '[{"item_name":"Managed Cloud Server & Backup Storage (Paket Pro)","qty":6,"unit_price":5500000,"remaining_qty":6,"grn_received_qty":6}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-006',
    'CV Prima Kerta Abadi',
    'GOODS',
    'IDR',
    '[{"item_name":"Kertas HVS A4 80gsm (Box isi 5 Rim)","qty":150,"unit_price":240000,"remaining_qty":150,"grn_received_qty":150}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-007',
    'PT Garda Sinergi Elektrika',
    'GOODS',
    'IDR',
    '[{"item_name":"UPS Industrial 5kVA Rackmount + Instalasi","qty":3,"unit_price":12000000,"remaining_qty":3,"grn_received_qty":3}]'::jsonb,
    'OPEN'
  ),
  (
    'PO-2026-008',
    'PT Sentosa Kimia Industri',
    'GOODS',
    'IDR',
    '[{"item_name":"Cairan Pembersih Lantai Industri (Jerigen 20L)","qty":80,"unit_price":350000,"remaining_qty":80,"grn_received_qty":80}]'::jsonb,
    'OPEN'
  )
ON CONFLICT (po_number) DO NOTHING;

-- 5. Seed Data: Initial Realistic Audit History (3 Sample Logs)
INSERT INTO audit_logs (
  id, file_name, file_hash, invoice_number, po_number, vendor_name, currency,
  grand_total, audit_status, reasons, extraction_data, po_snapshot, model_used, latency_ms, cost_idr
)
VALUES
  (
    '11111111-1111-4111-8111-111111111101',
    'INV_03_normal_kemasan.pdf',
    'seed-hash-inv-03-kemasan',
    'INV/SK/2026/088',
    'PO-2026-003',
    'PT Sumber Kemasan',
    'IDR',
    41070000,
    'APPROVED',
    '[]'::jsonb,
    '{"invoice_number":"INV/SK/2026/088","po_number":"PO-2026-003","vendor_name":"PT Sumber Kemasan","currency":"IDR","grand_total":41070000,"ppn_amount":4070000,"pph23_amount":0,"confidence_score":0.99}'::jsonb,
    '{"po_number":"PO-2026-003","vendor_name":"PT Sumber Kemasan","po_type":"GOODS","currency":"IDR","status":"OPEN","items":[{"item_name":"Kardus Corrugated Double Wall 60x40x40 cm","qty":2000,"unit_price":18500,"grn_received_qty":2000}]}'::jsonb,
    'gemini-3.8-flash',
    1180,
    3.12
  ),
  (
    '11111111-1111-4111-8111-111111111102',
    'INV_06_price_variance_prima.pdf',
    'seed-hash-inv-06-prima',
    'INV/PKA/2026/032',
    'PO-2026-006',
    'CV Prima Kerta Abadi',
    'IDR',
    43956000,
    'HOLD - PRICE VARIANCE',
    '["Price variance on PO-2026-006: billed unit price Rp264.000 vs contracted PO Rp240.000 (+10%)."]'::jsonb,
    '{"invoice_number":"INV/PKA/2026/032","po_number":"PO-2026-006","vendor_name":"CV Prima Kerta Abadi","currency":"IDR","grand_total":43956000,"ppn_amount":4356000,"pph23_amount":0,"confidence_score":0.97}'::jsonb,
    '{"po_number":"PO-2026-006","vendor_name":"CV Prima Kerta Abadi","po_type":"GOODS","currency":"IDR","status":"OPEN","items":[{"item_name":"Kertas HVS A4 80gsm (Box isi 5 Rim)","qty":150,"unit_price":240000,"grn_received_qty":150}]}'::jsonb,
    'gemini-3.8-flash',
    1245,
    3.45
  ),
  (
    '11111111-1111-4111-8111-111111111103',
    'WILD_05_multipage_noisy.pdf',
    'seed-hash-wild-05-noisy',
    'INV/GSK/2026/099',
    'PO-2026-004',
    'PT Graha Suplai Kantor',
    'IDR',
    21090000,
    'HUMAN REVIEW',
    '["OCR confidence score (0.72) is below threshold 0.85 due to noisy/blurry multi-page scan."]'::jsonb,
    '{"invoice_number":"INV/GSK/2026/099","po_number":"PO-2026-004","vendor_name":"PT Graha Suplai Kantor","currency":"IDR","grand_total":21090000,"ppn_amount":2090000,"pph23_amount":0,"confidence_score":0.72}'::jsonb,
    '{"po_number":"PO-2026-004","vendor_name":"PT Graha Suplai Kantor","po_type":"GOODS","currency":"IDR","status":"OPEN","items":[{"item_name":"Kertas A4 80gsm (Box 5 Rim)","qty":20,"unit_price":250000,"grn_received_qty":20},{"item_name":"Toner LaserJet Black Original","qty":4,"unit_price":1250000,"grn_received_qty":4}]}'::jsonb,
    'gemini-3.8-flash',
    1640,
    4.88
  )
ON CONFLICT (id) DO NOTHING;
