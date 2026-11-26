'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createLocalServer } = require('../../src/localServer');

async function runE2E() {
  const server = createLocalServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const isHeadless = process.env.CI === 'true' || process.env.HEADLESS === '1';
  const browser = await chromium.launch({
    headless: isHeadless,
    slowMo: isHeadless ? 0 : 300,
  });

  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 840 } });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#openVendorMasterBtn', { timeout: 10000 });

    // Open Vendor Master modal and verify seeded vendors load from /api/vendors
    await page.click('#openVendorMasterBtn');
    await page.waitForSelector('#vendorMasterModal:not(.hidden)', { timeout: 5000 });
    await page.waitForFunction(
      () => document.querySelectorAll('#vendorMasterTableBody tr').length >= 1,
      { timeout: 5000 }
    );
    const vendorRows = await page.locator('#vendorMasterTableBody tr').count();
    assert.ok(vendorRows >= 1, 'Expected Vendor Master table to render seeded vendors');
    await page.click('[data-close-enterprise-modal="vendorMasterModal"]');

    // Open Immutable Audit Trail modal
    await page.click('#openAuditEventsBtn');
    await page.waitForSelector('#auditEventsModal:not(.hidden)', { timeout: 5000 });
    await page.click('[data-close-enterprise-modal="auditEventsModal"]');

    // Verify /api/health returns 200 OK
    const health = await page.evaluate(async () => {
      const r = await fetch('/api/health');
      return { status: r.status, body: await r.json() };
    });
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.version, '6.0.0');

    assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join('; ')}`);
    console.log(`E2E PASS: Dashboard loaded, Vendor Master (${vendorRows} rows), Audit Trail, and /api/health verified (0 page errors).`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

runE2E().catch((err) => {
  console.error('E2E FAIL:', err.message);
  process.exit(1);
});
