"""Generate synthetic Indonesian B2B corporate test suite for Invoice vs. PO auditing."""

import csv
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

BASE_DIR = Path(__file__).resolve().parent
TEST_DATA_DIR = BASE_DIR / "test_data"
INVOICES_DIR = TEST_DATA_DIR / "invoices"

COMPANY_BUYER = {
    "name": "PT Maju Bersama Sejahtera Tbk",
    "department": "Divisi Finance / Accounts Payable",
    "address": "Gedung Graha Sentosa Lt. 12, Jl. Jend. Sudirman Kav. 52-53, Jakarta Selatan 12190",
    "npwp": "01.234.567.8-012.000",
}

PURCHASE_ORDERS = [
    {
        "po_number": "PO-2026-001",
        "vendor_name": "PT Nusantara Logistik",
        "vendor_address": "Jl. Raya Cakung Cilincing Km. 4, Jakarta Timur 13910",
        "vendor_npwp": "02.411.889.1-004.000",
        "item_name": "Sewa Armada Truk Box Engkel (Jakarta-Surabaya)",
        "qty": 4,
        "unit_price": 4_500_000,
        "status": "OPEN",
    },
    {
        "po_number": "PO-2026-002",
        "vendor_name": "CV Teknologi Kantor",
        "vendor_address": "Ruko Mangga Dua Mall Blok B2 No. 18, Jakarta Pusat 10730",
        "vendor_npwp": "03.522.104.7-026.000",
        "item_name": "Lisensi Software Akuntansi Enterprise (Tahunan)",
        "qty": 10,
        "unit_price": 2_500_000,
        "status": "OPEN",
    },
    {
        "po_number": "PO-2026-003",
        "vendor_name": "PT Sumber Kemasan",
        "vendor_address": "Kawasan Industri Jababeka II Blok F-11, Cikarang, Bekasi 17530",
        "vendor_npwp": "01.876.332.4-413.000",
        "item_name": "Kardus Corrugated Double Wall 60x40x40 cm",
        "qty": 2000,
        "unit_price": 18_500,
        "status": "OPEN",
    },
    {
        "po_number": "PO-2026-004",
        "vendor_name": "PT Mitra Baja Mandiri",
        "vendor_address": "Jl. Daan Mogot Km. 16, Kalideres, Jakarta Barat 11840",
        "vendor_npwp": "02.990.441.2-034.000",
        "item_name": "Rak Gudang Heavy Duty 4 Susun (Kapasitas 2 Ton)",
        "qty": 12,
        "unit_price": 3_200_000,
        "status": "OPEN",
    },
    {
        "po_number": "PO-2026-005",
        "vendor_name": "PT Solusi Cloud Nusantara",
        "vendor_address": "Menara Cyber 2 Lt. 15, Jl. HR Rasuna Said Blok X-5, Jakarta 12950",
        "vendor_npwp": "31.445.678.9-011.000",
        "item_name": "Managed Cloud Server & Backup Storage (Paket Pro)",
        "qty": 6,
        "unit_price": 5_500_000,
        "status": "OPEN",
    },
    {
        "po_number": "PO-2026-006",
        "vendor_name": "CV Prima Kerta Abadi",
        "vendor_address": "Jl. Pangeran Jayakarta No. 117, Sawah Besar, Jakarta Pusat 10730",
        "vendor_npwp": "04.112.908.3-021.000",
        "item_name": "Kertas HVS A4 80gsm (Box isi 5 Rim)",
        "qty": 150,
        "unit_price": 240_000,
        "status": "OPEN",
    },
    {
        "po_number": "PO-2026-007",
        "vendor_name": "PT Garda Sinergi Elektrika",
        "vendor_address": "Jl. TB Simatupang Kav. 88, Pasar Minggu, Jakarta Selatan 12520",
        "vendor_npwp": "01.665.219.5-017.000",
        "item_name": "UPS Industrial 5kVA Rackmount + Instalasi",
        "qty": 3,
        "unit_price": 12_000_000,
        "status": "OPEN",
    },
    {
        "po_number": "PO-2026-008",
        "vendor_name": "PT Sentosa Kimia Industri",
        "vendor_address": "Kawasan Industri MM2100 Blok J-5, Cibitung, Bekasi 17520",
        "vendor_npwp": "02.774.510.6-431.000",
        "item_name": "Cairan Pembersih Lantai Industri (Jerigen 20L)",
        "qty": 80,
        "unit_price": 350_000,
        "status": "OPEN",
    },
]


def format_idr(amount: int) -> str:
    """Format integer amount as Indonesian Rupiah string."""
    return f"Rp {amount:,.0f}".replace(",", ".")


def enrich_po_records() -> list[dict]:
    """Compute subtotal, 11% PPN tax, and grand total for each PO."""
    enriched = []
    for po in PURCHASE_ORDERS:
        subtotal = po["qty"] * po["unit_price"]
        tax_11 = round(subtotal * 0.11)
        total = subtotal + tax_11
        enriched.append(
            {
                **po,
                "expected_subtotal": subtotal,
                "expected_tax_11": tax_11,
                "expected_total": total,
            }
        )
    return enriched


def write_master_po_csv(po_records: list[dict]) -> Path:
    """Write Master_PO.csv with the required corporate PO columns."""
    csv_path = TEST_DATA_DIR / "Master_PO.csv"
    fieldnames = [
        "po_number",
        "vendor_name",
        "item_name",
        "qty",
        "unit_price",
        "expected_subtotal",
        "expected_tax_11",
        "expected_total",
        "status",
    ]
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in po_records:
            writer.writerow({k: row[k] for k in fieldnames})
    return csv_path


def render_clean_invoice_pdf(
    output_path: Path,
    po: dict,
    invoice_number: str,
    invoice_date: str,
    due_date: str,
    billed_unit_price: int,
    billed_tax: int | None = None,
) -> dict:
    """Render a crisp B2B corporate invoice PDF using ReportLab."""
    qty = po["qty"]
    subtotal = qty * billed_unit_price
    tax_11 = round(subtotal * 0.11) if billed_tax is None else billed_tax
    grand_total = subtotal + tax_11

    c = canvas.Canvas(str(output_path), pagesize=A4)
    width, height = A4
    margin_x = 22 * mm

    # Vendor letterhead band
    c.setFillColor(colors.HexColor("#1B365D"))
    c.rect(0, height - 34 * mm, width, 34 * mm, fill=1, stroke=0)

    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(margin_x, height - 15 * mm, po["vendor_name"].upper())
    c.setFont("Helvetica", 9)
    c.drawString(margin_x, height - 21 * mm, po["vendor_address"])
    c.drawString(margin_x, height - 26 * mm, f"NPWP: {po['vendor_npwp']}")

    c.setFont("Helvetica-Bold", 18)
    c.drawRightString(width - margin_x, height - 18 * mm, "INVOICE")

    # Invoice metadata & Bill To block
    y = height - 48 * mm
    c.setFillColor(colors.HexColor("#111827"))
    c.setFont("Helvetica-Bold", 10)
    c.drawString(margin_x, y, "TAGIHAN KEPADA (BILL TO):")
    c.setFont("Helvetica-Bold", 10)
    c.drawString(margin_x, y - 5 * mm, COMPANY_BUYER["name"])
    c.setFont("Helvetica", 9)
    c.drawString(margin_x, y - 10 * mm, COMPANY_BUYER["department"])
    c.drawString(margin_x, y - 15 * mm, COMPANY_BUYER["address"])
    c.drawString(margin_x, y - 20 * mm, f"NPWP: {COMPANY_BUYER['npwp']}")

    meta_x_label = width - 78 * mm
    meta_x_val = width - margin_x
    meta_rows = [
        ("No. Invoice:", invoice_number),
        ("Tanggal Invoice:", invoice_date),
        ("Jatuh Tempo:", due_date),
        ("Referensi PO:", po["po_number"]),
        ("Mata Uang:", "IDR (Rupiah)"),
    ]
    for idx, (label, val) in enumerate(meta_rows):
        row_y = y - idx * 5.2 * mm
        c.setFont("Helvetica-Bold", 9)
        c.drawString(meta_x_label, row_y, label)
        c.setFont("Helvetica", 9)
        c.drawRightString(meta_x_val, row_y, val)

    # Line items table
    table_y = y - 34 * mm
    table_data = [
        ["No.", "Deskripsi Barang / Jasa", "Qty", "Harga Satuan (IDR)", "Jumlah (IDR)"],
        [
            "1",
            po["item_name"],
            f"{qty:,}".replace(",", "."),
            format_idr(billed_unit_price),
            format_idr(subtotal),
        ],
    ]
    col_widths = [12 * mm, 76 * mm, 16 * mm, 31 * mm, 31 * mm]
    table = Table(table_data, colWidths=col_widths)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1B365D")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 0), 9),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 1), (-1, -1), 9),
                ("ALIGN", (0, 0), (0, -1), "CENTER"),
                ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#F8FAFC")]),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    _, table_h = table.wrapOn(c, width, height)
    table.drawOn(c, margin_x, table_y - table_h)

    # Totals summary box
    summary_y = table_y - table_h - 14 * mm
    summary_data = [
        ["Subtotal", format_idr(subtotal)],
        ["PPN 11%", format_idr(tax_11)],
        ["GRAND TOTAL", format_idr(grand_total)],
    ]
    summary_table = Table(summary_data, colWidths=[38 * mm, 38 * mm])
    summary_table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, 1), "Helvetica"),
                ("FONTNAME", (0, 2), (-1, 2), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 1), 9.5),
                ("FONTSIZE", (0, 2), (-1, 2), 10.5),
                ("BACKGROUND", (0, 2), (-1, 2), colors.HexColor("#E2E8F0")),
                ("ALIGN", (0, 0), (0, -1), "LEFT"),
                ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                ("LINEABOVE", (0, 2), (-1, 2), 1, colors.HexColor("#1B365D")),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#94A3B8")),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    _, sum_h = summary_table.wrapOn(c, width, height)
    summary_table.drawOn(c, width - margin_x - 76 * mm, summary_y - sum_h)

    # Payment & signature footer
    footer_y = summary_y - sum_h - 22 * mm
    c.setFont("Helvetica-Bold", 9)
    c.drawString(margin_x, footer_y, "Instruksi Pembayaran:")
    c.setFont("Helvetica", 8.5)
    c.drawString(margin_x, footer_y - 5 * mm, f"Bank Mandiri KCP Jakarta Sudirman - No. Rek: 102-00-8899123-4 a.n. {po['vendor_name']}")
    c.drawString(margin_x, footer_y - 10 * mm, "Mohon cantumkan Nomor Invoice dan Nomor PO pada berita transfer.")

    c.setFont("Helvetica", 9)
    c.drawRightString(width - margin_x, footer_y, "Hormat Kami,")
    c.line(width - margin_x - 45 * mm, footer_y - 20 * mm, width - margin_x, footer_y - 20 * mm)
    c.setFont("Helvetica-Bold", 9)
    c.drawRightString(width - margin_x, footer_y - 25 * mm, "Finance & Billing Dept.")

    c.showPage()
    c.save()

    return {
        "invoice_number": invoice_number,
        "po_number": po["po_number"],
        "vendor_name": po["vendor_name"],
        "billed_unit_price": billed_unit_price,
        "billed_subtotal": subtotal,
        "billed_tax_11": tax_11,
        "billed_total": grand_total,
    }


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Load a clean TrueType font if installed, falling back to Pillow default."""
    candidates = (
        [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        ]
        if bold
        else [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
        ]
    )
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default(size=size)


def render_low_confidence_scan_pdf(
    output_path: Path,
    po: dict,
    invoice_number: str,
    invoice_date: str,
    due_date: str,
) -> dict:
    """Render an invoice as a degraded, skewed, blurry scanned image inside a PDF."""
    width, height = 1240, 1754  # ~150 DPI A4
    img = Image.new("RGB", (width, height), color=(244, 242, 236))
    draw = ImageDraw.Draw(img)

    f_title = load_font(34, bold=True)
    f_head = load_font(22, bold=True)
    f_body = load_font(19, bold=False)
    f_small = load_font(16, bold=False)

    # Header
    draw.rectangle([0, 0, width, 170], fill=(32, 54, 88))
    draw.text((70, 40), po["vendor_name"].upper(), fill=(250, 250, 250), font=f_title)
    draw.text((70, 90), po["vendor_address"], fill=(225, 225, 225), font=f_small)
    draw.text((70, 120), f"NPWP: {po['vendor_npwp']}", fill=(225, 225, 225), font=f_small)
    draw.text((980, 55), "INVOICE", fill=(250, 250, 250), font=f_title)

    # Metadata
    draw.text((70, 220), "TAGIHAN KEPADA:", fill=(25, 25, 25), font=f_head)
    draw.text((70, 255), COMPANY_BUYER["name"], fill=(25, 25, 25), font=f_body)
    draw.text((70, 285), COMPANY_BUYER["department"], fill=(45, 45, 45), font=f_small)

    draw.text((740, 220), f"No. Invoice : {invoice_number}", fill=(25, 25, 25), font=f_body)
    draw.text((740, 255), f"Tanggal     : {invoice_date}", fill=(25, 25, 25), font=f_body)
    draw.text((740, 290), f"Jatuh Tempo : {due_date}", fill=(25, 25, 25), font=f_body)
    draw.text((740, 325), f"Ref. PO     : {po['po_number']}", fill=(25, 25, 25), font=f_body)

    # Item table
    draw.rectangle([70, 410, 1170, 465], fill=(32, 54, 88))
    draw.text((85, 425), "Deskripsi", fill=(255, 255, 255), font=f_head)
    draw.text((620, 425), "Qty", fill=(255, 255, 255), font=f_head)
    draw.text((740, 425), "Harga Satuan", fill=(255, 255, 255), font=f_head)
    draw.text((980, 425), "Jumlah", fill=(255, 255, 255), font=f_head)

    draw.rectangle([70, 465, 1170, 540], outline=(130, 130, 130), width=2)
    draw.text((85, 490), po["item_name"], fill=(25, 25, 25), font=f_body)
    draw.text((620, 490), str(po["qty"]), fill=(25, 25, 25), font=f_body)
    draw.text((740, 490), format_idr(po["unit_price"]), fill=(25, 25, 25), font=f_body)
    draw.text((980, 490), format_idr(po["expected_subtotal"]), fill=(25, 25, 25), font=f_body)

    # Totals
    draw.rectangle([720, 610, 1170, 770], outline=(100, 100, 100), width=2)
    draw.text((740, 625), "Subtotal:", fill=(25, 25, 25), font=f_body)
    draw.text((960, 625), format_idr(po["expected_subtotal"]), fill=(25, 25, 25), font=f_body)
    draw.text((740, 670), "PPN 11%:", fill=(25, 25, 25), font=f_body)
    draw.text((960, 670), format_idr(po["expected_tax_11"]), fill=(25, 25, 25), font=f_body)
    draw.text((740, 720), "GRAND TOTAL:", fill=(20, 20, 20), font=f_head)
    draw.text((960, 720), format_idr(po["expected_total"]), fill=(20, 20, 20), font=f_head)

    # Degrade numeric region heavily to simulate smudged/low-DPI scanner output
    numeric_crop = img.crop((600, 465, 1170, 770)).filter(ImageFilter.GaussianBlur(radius=3.6))
    numeric_crop = ImageEnhance.Contrast(numeric_crop).enhance(0.55)
    img.paste(numeric_crop, (600, 465))

    # Add scanner speckle noise & slight rotation + global blur
    rng = random.Random(42)
    pixels = img.load()
    for _ in range(18_000):
        px = rng.randint(0, width - 1)
        py = rng.randint(0, height - 1)
        shade = rng.randint(150, 215)
        pixels[px, py] = (shade, shade, shade)

    img = img.rotate(1.9, resample=Image.Resampling.BICUBIC, fillcolor=(235, 233, 228))
    img = img.filter(ImageFilter.GaussianBlur(radius=1.6))
    img.save(output_path, "PDF", resolution=150.0)

    return {
        "invoice_number": invoice_number,
        "po_number": po["po_number"],
        "vendor_name": po["vendor_name"],
        "billed_unit_price": po["unit_price"],
        "billed_subtotal": po["expected_subtotal"],
        "billed_tax_11": po["expected_tax_11"],
        "billed_total": po["expected_total"],
    }


def generate_suite() -> None:
    """Create Master_PO.csv, 10 scenario PDFs, and expected_results.json."""
    TEST_DATA_DIR.mkdir(parents=True, exist_ok=True)
    INVOICES_DIR.mkdir(parents=True, exist_ok=True)

    po_records = enrich_po_records()
    po_by_num = {po["po_number"]: po for po in po_records}
    write_master_po_csv(po_records)

    expected_results = []

    # 5 NORMAL scenarios (100% match Master_PO.csv)
    normal_specs = [
        ("INV_01_normal_nusantara.pdf", "PO-2026-001", "INV/NL/2026/001", "2026-11-02", "2026-12-02"),
        ("INV_02_normal_teknologi.pdf", "PO-2026-002", "INV/TK/2026/014", "2026-11-03", "2026-12-03"),
        ("INV_03_normal_kemasan.pdf", "PO-2026-003", "INV/SK/2026/088", "2026-11-04", "2026-12-04"),
        ("INV_04_normal_baja.pdf", "PO-2026-004", "INV/MBM/2026/021", "2026-11-05", "2026-12-05"),
        ("INV_05_normal_cloud.pdf", "PO-2026-005", "INV/SCN/2026/105", "2026-11-06", "2026-12-06"),
    ]
    for fname, po_num, inv_num, inv_dt, due_dt in normal_specs:
        po = po_by_num[po_num]
        meta = render_clean_invoice_pdf(
            INVOICES_DIR / fname, po, inv_num, inv_dt, due_dt, po["unit_price"]
        )
        expected_results.append(
            {
                "file_name": fname,
                "scenario": "NORMAL",
                "expected_status": "APPROVED",
                "reason": "100% cocok dengan Master_PO (harga satuan, qty, PPN 11%, dan grand total sesuai).",
                **meta,
            }
        )

    # 2 PRICE VARIANCE traps (+10% and +15% unit price)
    variance_specs = [
        ("INV_06_price_variance_prima.pdf", "PO-2026-006", "INV/PKA/2026/032", 0.10, "2026-11-07", "2026-12-07"),
        ("INV_07_price_variance_garda.pdf", "PO-2026-007", "INV/GSE/2026/009", 0.15, "2026-11-08", "2026-12-08"),
    ]
    for fname, po_num, inv_num, markup, inv_dt, due_dt in variance_specs:
        po = po_by_num[po_num]
        inflated_price = round(po["unit_price"] * (1 + markup))
        meta = render_clean_invoice_pdf(
            INVOICES_DIR / fname, po, inv_num, inv_dt, due_dt, inflated_price
        )
        expected_results.append(
            {
                "file_name": fname,
                "scenario": f"PRICE_VARIANCE_+{int(markup * 100)}%",
                "expected_status": "HOLD - PRICE VARIANCE",
                "reason": (
                    f"Harga satuan ditagihkan {format_idr(inflated_price)}, "
                    f"naik {int(markup * 100)}% dari harga PO {format_idr(po['unit_price'])}."
                ),
                **meta,
            }
        )

    # 1 TAX ERROR trap (unit_price matches PO, PPN/Grand Total inflated by +Rp500.000)
    po_tax = po_by_num["PO-2026-008"]
    wrong_tax = po_tax["expected_tax_11"] + 500_000
    meta_tax = render_clean_invoice_pdf(
        INVOICES_DIR / "INV_08_tax_error_sentosa.pdf",
        po_tax,
        "INV/SKI/2026/045",
        "2026-11-09",
        "2026-12-09",
        po_tax["unit_price"],
        billed_tax=wrong_tax,
    )
    expected_results.append(
        {
            "file_name": "INV_08_tax_error_sentosa.pdf",
            "scenario": "TAX_ERROR",
            "expected_status": "HOLD - TAX ERROR",
            "reason": (
                f"Harga satuan & subtotal sesuai PO ({format_idr(po_tax['expected_subtotal'])}), "
                f"tetapi PPN 11% dan Grand Total salah hitung +Rp 500.000 "
                f"(tertagih {format_idr(meta_tax['billed_total'])} vs seharusnya {format_idr(po_tax['expected_total'])})."
            ),
            **meta_tax,
        }
    )

    # 1 DUPLICATE BILLING trap (identical invoice number & content to INV_01)
    po_dup = po_by_num["PO-2026-001"]
    meta_dup = render_clean_invoice_pdf(
        INVOICES_DIR / "INV_09_duplicate_nusantara_copy.pdf",
        po_dup,
        "INV/NL/2026/001",
        "2026-11-02",
        "2026-12-02",
        po_dup["unit_price"],
    )
    expected_results.append(
        {
            "file_name": "INV_09_duplicate_nusantara_copy.pdf",
            "scenario": "DUPLICATE_BILLING",
            "expected_status": "HOLD - DUPLICATE",
            "reason": "Nomor invoice INV/NL/2026/001 dan isi identik dengan INV_01_normal_nusantara.pdf.",
            **meta_dup,
        }
    )

    # 1 LOW CONFIDENCE trap (skewed, noisy, blurry scanned PDF)
    po_low = po_by_num["PO-2026-003"]
    meta_low = render_low_confidence_scan_pdf(
        INVOICES_DIR / "INV_10_low_confidence_kemasan.pdf",
        po_low,
        "INV/SK/2026/099",
        "2026-11-10",
        "2026-12-10",
    )
    expected_results.append(
        {
            "file_name": "INV_10_low_confidence_kemasan.pdf",
            "scenario": "LOW_CONFIDENCE_SCAN",
            "expected_status": "HUMAN REVIEW",
            "reason": "Kualitas scan buruk (miring, noise, dan area angka buram) sehingga OCR berisiko low confidence.",
            **meta_low,
        }
    )

    results_path = TEST_DATA_DIR / "expected_results.json"
    results_path.write_text(
        json.dumps({"total_invoices": len(expected_results), "results": expected_results}, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    generate_suite()
    print("Synthetic Corporate Test Suite generated successfully.")
