import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = (name: string) => path.resolve(here, '../../../samples', name);
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(here, 'screenshots', `${name}.png`), fullPage: true, animations: 'disabled' });

const consoleErrors: string[] = [];

async function newPage(browser: Browser, label: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', (m) => {
    // Chrome logs every non-2xx response; the 422 from uploading invalid.csv is the expected, handled case.
    if (m.type() === 'error' && !/status of 422/.test(m.text())) consoleErrors.push(`[${label}] ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[${label}] ${e.message}`));
  return page;
}

async function loginAs(browser: Browser, name: string, screenshot = false) {
  const page = await newPage(browser, name);
  await page.goto('/login');
  const card = page.locator('.user-card').filter({ has: page.locator('.user-card-name', { hasText: new RegExp(`^${name}$`) }) });
  await expect(card).toBeVisible();
  if (screenshot) await shot(page, '01-login');
  await card.click();
  await page.waitForURL('**/batches');
  return page;
}

async function approve(page: Page) {
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(/^Recorded Approve\./)).toBeVisible();
}

test('demo flow: upload, live review, issue, verify, revoke', async ({ browser }) => {
  const course = `E2E Retail ${Date.now()}`;
  let batchUrl = '';
  let certNo = '';

  const anika = await loginAs(browser, 'Anika', true);

  await test.step('1. Anika creates a batch and sees row errors for invalid.csv', async () => {
    await anika.getByRole('button', { name: 'New batch' }).click();
    await anika.getByLabel('Course name').fill(course);
    await anika.getByRole('button', { name: 'Create batch' }).click();
    await anika.waitForURL(/\/batches\/[a-z0-9]+$/);
    batchUrl = new URL(anika.url()).pathname;

    await anika.getByLabel('Candidate CSV file').setInputFiles(sample('invalid.csv'));
    await anika.getByRole('button', { name: 'Upload CSV' }).click();
    const errorRows = anika.locator('.csv-errors tbody tr');
    await expect(errorRows).toHaveCount(5);
    await expect(errorRows.locator('td:first-child')).toHaveText(['9', '10', '11', '12', '13']);
    await shot(anika, '02-csv-errors');
  });

  // Dev is watching the list BEFORE Anika submits, so the batch must arrive over SSE.
  const dev = await loginAs(browser, 'Dev');
  await expect(dev.getByRole('tab', { name: /Waiting for me/ })).toHaveAttribute('aria-selected', 'true');
  await expect(dev.getByText(course)).toHaveCount(0);

  await test.step('2. Anika uploads valid-10.csv and submits', async () => {
    await anika.getByLabel('Candidate CSV file').setInputFiles(sample('valid-10.csv'));
    await anika.getByRole('button', { name: 'Upload CSV' }).click();
    await expect(anika.getByText('Uploaded 10 candidates')).toBeVisible();
    await expect(anika.getByRole('heading', { name: 'Candidates (10)' })).toBeVisible();
    await anika.getByRole('button', { name: 'Submit for review' }).click();
    await expect(anika.locator('.head-meta .badge').first()).toHaveText('District review');
  });

  await test.step('3. Dev sees it in "Waiting for me" without a reload, then approves', async () => {
    const row = dev.getByRole('link', { name: course });
    await expect(row).toBeVisible({ timeout: 10_000 }); // no page.reload() anywhere
    await shot(dev, '03-batches-waiting-for-me');
    await row.click();
    await approve(dev);
    await expect(dev.getByText('Waiting for a second district officer')).toBeVisible();
  });

  const farah = await loginAs(browser, 'Farah');
  await test.step('4. Meera approves, then Farah approves', async () => {
    const meera = await loginAs(browser, 'Meera');
    await meera.goto(batchUrl);
    await approve(meera);
    await expect(meera.locator('.head-meta .badge').first()).toHaveText('State review');
    await shot(meera, '04-batch-detail-review');

    await farah.goto(batchUrl);
    await approve(farah);
  });

  await test.step('5. 10 certificates are listed (issued by the worker, live)', async () => {
    await expect(farah.locator('.head-meta .badge').first()).toHaveText('Issued', { timeout: 30_000 });
    const certRows = farah.locator('.card:has(h2:has-text("Certificates")) tbody tr');
    await expect(certRows).toHaveCount(10, { timeout: 30_000 });
    certNo = (await certRows.first().locator('td').first().innerText()).trim();
    expect(certNo).toMatch(/^CF-[0-9A-HJKMNP-TV-Z]{10}$/);
    // Let a few WhatsApp deliveries tick over before the screenshot.
    await expect(farah.locator('.card:has(h2:has-text("Certificates")) .badge', { hasText: 'Sent' }).first()).toBeVisible({ timeout: 30_000 });
    await shot(farah, '05-batch-detail-certificates');
  });

  const publicPage = await newPage(browser, 'public');
  await test.step('6. Public verify (no login) shows VALID', async () => {
    await publicPage.goto(`/verify/${certNo}`);
    await expect(publicPage.getByText('Valid certificate')).toBeVisible();
    await expect(publicPage.locator('.details')).toContainText(certNo);
    await shot(publicPage, '06-verify-valid');
    await publicPage.setViewportSize({ width: 390, height: 844 });
    await shot(publicPage, '06b-verify-valid-mobile');
    await publicPage.setViewportSize({ width: 1280, height: 800 });
  });

  await test.step('7. Farah revokes it; verify shows REVOKED after reload', async () => {
    const row = farah.locator('tbody tr', { hasText: certNo });
    await row.getByRole('button', { name: 'Revoke' }).click();
    await farah.getByRole('dialog').getByLabel(/Reason/).fill('E2E: issued in error, revoking for the demo');
    await farah.getByRole('dialog').getByRole('button', { name: 'Revoke certificate' }).click();
    await expect(farah.getByText(`Certificate ${certNo} revoked`)).toBeVisible();
    await expect(row.locator('.badge').first()).toHaveText('Revoked');

    await publicPage.reload();
    await expect(publicPage.getByText('This certificate has been revoked and is not valid')).toBeVisible();
    await shot(publicPage, '07-verify-revoked');
  });

  await test.step('State dashboard and WhatsApp outbox render', async () => {
    await farah.goto('/state');
    await expect(farah.locator('.tile').first()).toBeVisible();
    await shot(farah, '08-state-dashboard');
    await farah.goto('/whatsapp');
    await expect(farah.locator('.message').first()).toBeVisible();
    await shot(farah, '09-whatsapp-outbox');
  });

  expect(consoleErrors, 'browser console errors').toEqual([]);
});
