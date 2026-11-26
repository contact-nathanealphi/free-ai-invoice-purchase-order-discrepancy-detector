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
  reviewer_note TEXT,
  created_by TEXT,
  storage_path TEXT
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

-- 6. Vendor Master (Anti-BEC Bank Account & NPWP Fraud Guard)
CREATE TABLE IF NOT EXISTS vendor_master (
  vendor_code TEXT PRIMARY KEY,
  vendor_name TEXT NOT NULL UNIQUE,
  npwp TEXT,
  bank_name TEXT NOT NULL,
  bank_account_number TEXT NOT NULL,
  bank_account_holder TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BLOCKED')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_master_name_lower ON vendor_master (LOWER(vendor_name));

INSERT INTO vendor_master (vendor_code, vendor_name, npwp, bank_name, bank_account_number, bank_account_holder, status)
VALUES
  ('VND-001', 'PT Andalan Perkakas Nusantara', '01.234.567.8-011.000', 'Bank Mandiri', '1230004567890', 'PT Andalan Perkakas Nusantara', 'ACTIVE'),
  ('VND-002', 'CV Karya Mandiri Logistik', '02.345.678.9-012.000', 'BCA', '5410987654', 'CV Karya Mandiri Logistik', 'ACTIVE'),
  ('VND-003', 'PT Konsultan Digital Prima', '03.456.789.0-013.000', 'BNI', '0891234567', 'PT Konsultan Digital Prima', 'ACTIVE'),
  ('VND-004', 'PT Graha Suplai Kantor', '04.567.890.1-014.000', 'BCA', '2730112233', 'PT Graha Suplai Kantor', 'ACTIVE'),
  ('VND-005', 'PT Sentra Komponen Elektronik', '05.678.901.2-015.000', 'Bank Mandiri', '1240009988776', 'PT Sentra Komponen Elektronik', 'ACTIVE'),
  ('VND-006', 'PT Global Teknologi Niaga', '06.789.012.3-016.000', 'CIMB Niaga', '800123456700', 'PT Global Teknologi Niaga', 'ACTIVE'),
  ('VND-007', 'PT Sumber Kemasan', '07.890.123.4-017.000', 'BCA', '3190445566', 'PT Sumber Kemasan', 'ACTIVE'),
  ('VND-008', 'CV Prima Kerta Abadi', '08.901.234.5-018.000', 'BRI', '020601001234301', 'CV Prima Kerta Abadi', 'ACTIVE')
ON CONFLICT (vendor_code) DO NOTHING;

-- 7. Immutable Append-Only Audit Events Trail (SOX / ISO 27001 Governance)
CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_log_id UUID NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_status TEXT,
  next_status TEXT NOT NULL,
  reason TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_log_id ON audit_events (audit_log_id, created_at ASC);

-- 8. Row Level Security (Service-role backend only; blocks direct anon/public access)
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purchase_orders_service_role_all" ON purchase_orders;
CREATE POLICY "purchase_orders_service_role_all" ON purchase_orders
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "audit_logs_service_role_all" ON audit_logs;
CREATE POLICY "audit_logs_service_role_all" ON audit_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_master_service_role_all" ON vendor_master;
CREATE POLICY "vendor_master_service_role_all" ON vendor_master
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "audit_events_service_role_all" ON audit_events;
CREATE POLICY "audit_events_service_role_all" ON audit_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 9. Transactional Postgres ACID RPC: Idempotent Audit Insert + Row-Locked PO Deduction + Audit Event
CREATE OR REPLACE FUNCTION record_audit_and_deduct_po(
  p_log JSONB,
  p_billed_lines JSONB DEFAULT '[]'::jsonb,
  p_actor_id TEXT DEFAULT 'system-admin',
  p_actor_role TEXT DEFAULT 'FINANCE_MANAGER',
  p_ip_address TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_log_id UUID;
  v_po_row purchase_orders%ROWTYPE;
  v_canonical_po TEXT;
  v_updated_items JSONB := '[]'::jsonb;
  v_item JSONB;
  v_line JSONB;
  v_billed_qty NUMERIC;
  v_curr_rem NUMERIC;
  v_new_rem NUMERIC;
  v_all_exhausted BOOLEAN := TRUE;
  v_next_po_status TEXT := NULL;
  v_po_updated BOOLEAN := FALSE;
  v_saved_log audit_logs%ROWTYPE;
  v_file_hash TEXT;
  v_effective_status TEXT;
  v_effective_reasons JSONB;
  v_is_duplicate BOOLEAN := FALSE;
BEGIN
  v_log_id := COALESCE(NULLIF(p_log->>'id', '')::uuid, gen_random_uuid());
  v_file_hash := NULLIF(TRIM(COALESCE(p_log->>'file_hash', '')), '');
  v_effective_status := p_log->>'audit_status';
  v_effective_reasons := COALESCE(p_log->'reasons', '[]'::jsonb);

  -- Row-level lock on PO when deducting balances for approved invoices
  IF v_effective_status IN ('APPROVED', 'APPROVED - PARTIAL')
     AND NULLIF(TRIM(COALESCE(p_log->>'po_number', '')), '') IS NOT NULL THEN
    v_canonical_po := UPPER(REGEXP_REPLACE(TRIM(p_log->>'po_number'), '[^A-Za-z0-9]+', '-', 'g'));
    v_canonical_po := TRIM(BOTH '-' FROM v_canonical_po);

    SELECT * INTO v_po_row
    FROM purchase_orders
    WHERE TRIM(BOTH '-' FROM UPPER(REGEXP_REPLACE(po_number, '[^A-Za-z0-9]+', '-', 'g'))) = v_canonical_po
    FOR UPDATE;

    -- Re-verify file_hash idempotency inside the row-locked transaction to prevent concurrent double-deduction
    IF v_file_hash IS NOT NULL AND EXISTS (SELECT 1 FROM audit_logs WHERE file_hash = v_file_hash) THEN
      v_is_duplicate := TRUE;
      v_effective_status := 'HOLD - DUPLICATE';
      v_effective_reasons := jsonb_build_array(
        'Concurrent duplicate file detected inside ACID transaction (SHA-256: ' || LEFT(v_file_hash, 12) || '...).'
      );
    ELSIF FOUND THEN
      FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_po_row.items, '[]'::jsonb)) LOOP
        v_billed_qty := 0;
        FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_billed_lines, '[]'::jsonb)) LOOP
          IF LOWER(TRIM(COALESCE(v_line->>'item_name', ''))) = LOWER(TRIM(COALESCE(v_item->>'item_name', ''))) THEN
            v_billed_qty := v_billed_qty + COALESCE((v_line->>'qty')::numeric, 0);
          END IF;
        END LOOP;

        v_curr_rem := COALESCE((v_item->>'remaining_qty')::numeric, (v_item->>'qty')::numeric, 0);
        v_new_rem := GREATEST(0, v_curr_rem - v_billed_qty);
        IF v_new_rem > 0 THEN
          v_all_exhausted := FALSE;
        END IF;

        v_updated_items := v_updated_items || jsonb_build_array(
          jsonb_set(v_item, '{remaining_qty}', to_jsonb(v_new_rem), true)
        );
      END LOOP;

      v_next_po_status := CASE WHEN v_all_exhausted THEN 'CLOSED' ELSE 'OPEN' END;
      UPDATE purchase_orders
      SET items = v_updated_items, status = v_next_po_status
      WHERE po_number = v_po_row.po_number;
      v_po_updated := TRUE;
    END IF;
  END IF;

  INSERT INTO audit_logs (
    id, created_at, file_name, file_hash, invoice_number, po_number, vendor_name,
    currency, grand_total, audit_status, reasons, extraction_data, po_snapshot,
    model_used, latency_ms, cost_idr, reviewer_action, reviewer_note, created_by, storage_path
  )
  VALUES (
    v_log_id,
    COALESCE(NULLIF(p_log->>'created_at', '')::timestamptz, NOW()),
    p_log->>'file_name',
    v_file_hash,
    p_log->>'invoice_number',
    p_log->>'po_number',
    p_log->>'vendor_name',
    COALESCE(NULLIF(p_log->>'currency', ''), 'IDR'),
    NULLIF(p_log->>'grand_total', '')::numeric,
    v_effective_status,
    v_effective_reasons,
    p_log->'extraction_data',
    p_log->'po_snapshot',
    p_log->>'model_used',
    NULLIF(p_log->>'latency_ms', '')::integer,
    COALESCE(NULLIF(p_log->>'cost_idr', '')::numeric, 0),
    p_log->>'reviewer_action',
    p_log->>'reviewer_note',
    COALESCE(NULLIF(p_log->>'created_by', ''), p_actor_id),
    p_log->>'storage_path'
  )
  RETURNING * INTO v_saved_log;

  INSERT INTO audit_events (
    audit_log_id, actor_id, actor_role, action, previous_status, next_status, reason, ip_address
  )
  VALUES (
    v_saved_log.id,
    COALESCE(NULLIF(p_actor_id, ''), 'system-admin'),
    COALESCE(NULLIF(UPPER(p_actor_role), ''), 'FINANCE_MANAGER'),
    'CREATED',
    NULL,
    v_saved_log.audit_status,
    COALESCE(p_log->'reasons'->>0, 'Initial automated audit completed.'),
    p_ip_address
  );

  RETURN jsonb_build_object(
    'audit_log', to_jsonb(v_saved_log),
    'po_updated', v_po_updated,
    'po_status', v_next_po_status,
    'duplicate', v_is_duplicate
  );
END;
$$;
