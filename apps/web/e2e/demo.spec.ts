import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = (name: string) => path.resolve(here, '../../../samples', name);
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(here, 'screenshots', `${name}.png`), fullPage: true, animations: 'disabled' });

let consoleErrors: string[] = [];
test.beforeEach(() => {
  consoleErrors = [];
});
test.afterEach(() => {
  expect(consoleErrors, 'browser console errors').toEqual([]);
});

async function newPage(browser: Browser, label: string) {
  const page = await (await browser.newContext()).newPage();
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

const statusBadge = (page: Page) => page.locator('.head-meta .badge').first();
const certRows = (page: Page) => page.locator('.card:has(h2:has-text("Certificates")) tbody tr');

async function createBatch(page: Page, course: string) {
  await page.getByRole('button', { name: 'New batch' }).click();
  await page.getByLabel('Course name').fill(course);
  await page.getByRole('button', { name: 'Create batch' }).click();
  await page.waitForURL(/\/batches\/[a-z0-9]+$/);
  return new URL(page.url()).pathname;
}

async function uploadCsv(page: Page, file: string, expectCount?: number) {
  await page.getByLabel('Candidate CSV file').setInputFiles(sample(file));
  await page.getByRole('button', { name: 'Upload CSV' }).click();
  if (expectCount) await expect(page.getByText(`Uploaded ${expectCount} candidates`)).toBeVisible();
}

async function approve(page: Page) {
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(/^Recorded Approve\./)).toBeVisible();
}

async function decideWithReason(page: Page, button: 'Return to centre' | 'Reject', reason: string) {
  await page.getByRole('button', { name: button, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Reason/).fill(reason);
  await dialog.getByRole('button', { name: button === 'Reject' ? 'Reject batch' : 'Return batch' }).click();
}

/** Anika creates a batch from a sample CSV and submits it; returns the batch URL. */
async function submittedBatch(browser: Browser, file: string, count: number, course = `E2E ${file} ${Date.now()}`) {
  const anika = await loginAs(browser, 'Anika');
  const url = await createBatch(anika, course);
  await uploadCsv(anika, file, count);
  await anika.getByRole('button', { name: 'Submit for review' }).click();
  await expect(statusBadge(anika)).toHaveText('District review');
  return { anika, url, course };
}

/** Full approval chain on a 10-candidate batch, ending ISSUED. */
async function issuedBatch(browser: Browser) {
  const b = await submittedBatch(browser, 'valid-10.csv', 10);
  for (const name of ['Dev', 'Meera', 'Farah']) {
    const p = await loginAs(browser, name);
    await p.goto(b.url);
    await approve(p);
  }
  await b.anika.goto(b.url);
  await expect(statusBadge(b.anika)).toHaveText('Issued', { timeout: 30_000 });
  await expect(certRows(b.anika)).toHaveCount(10, { timeout: 30_000 });
  return b;
}

test('demo flow: upload, live review, issue, verify, revoke', async ({ browser }) => {
  const course = `E2E Retail ${Date.now()}`;
  let batchUrl = '';
  let certNo = '';

  const anika = await loginAs(browser, 'Anika', true);

  await test.step('1. Anika creates a batch and sees row errors for invalid.csv', async () => {
    batchUrl = await createBatch(anika, course);
    await uploadCsv(anika, 'invalid.csv');
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
    await uploadCsv(anika, 'valid-10.csv', 10);
    await expect(anika.getByRole('heading', { name: 'Candidates (10)' })).toBeVisible();
    await expect(anika.locator('.card:has(h2:has-text("Candidates (")) tbody td.mono').nth(1)).toHaveText(/^[6-9]\d{9}$/); // owner sees full phone
    await anika.getByRole('button', { name: 'Submit for review' }).click();
    await expect(statusBadge(anika)).toHaveText('District review');
  });

  await test.step('3. Dev sees it in "Waiting for me" without a reload, then approves', async () => {
    const row = dev.getByRole('link', { name: course });
    await expect(row).toBeVisible({ timeout: 10_000 }); // no page.reload() anywhere
    await shot(dev, '03-batches-waiting-for-me');
    await row.click();
    await expect(dev.locator('.card:has(h2:has-text("Candidates (")) tbody td.mono').nth(1)).toHaveText(/^\*{6}\d{4}$/); // staff: masked
    await approve(dev);
    await expect(dev.getByText('Waiting for a second district officer')).toBeVisible();
  });

  const farah = await loginAs(browser, 'Farah');
  await test.step('4. Meera approves, then Farah approves', async () => {
    const meera = await loginAs(browser, 'Meera');
    await meera.goto(batchUrl);
    await approve(meera);
    await expect(statusBadge(meera)).toHaveText('State review');
    await shot(meera, '04-batch-detail-review');
    await farah.goto(batchUrl);
    await approve(farah);
  });

  await test.step('5. 10 certificates are listed (issued by the worker, live), none clipped', async () => {
    await expect(statusBadge(farah)).toHaveText('Issued', { timeout: 30_000 });
    await expect(certRows(farah)).toHaveCount(10, { timeout: 30_000 });
    // Every row is actually on screen: the table is not cut off by a scroll container.
    const wrap = farah.locator('.card:has(h2:has-text("Certificates")) .table-wrap');
    expect(await wrap.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await expect(certRows(farah).last()).toContainText('Rahul Nair');
    certNo = (await certRows(farah).first().locator('td').first().innerText()).trim();
    expect(certNo).toMatch(/^CF-[0-9A-HJKMNP-TV-Z]{10}$/);
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
});

test('a 60-candidate batch goes through quality review and issues 60 certificates', async ({ browser }) => {
  const { url } = await submittedBatch(browser, 'valid-60.csv', 60);
  for (const name of ['Dev', 'Meera']) {
    const p = await loginAs(browser, name);
    await p.goto(url);
    await approve(p);
  }
  const neha = await loginAs(browser, 'Neha');
  await neha.goto(url);
  await expect(statusBadge(neha)).toHaveText('Quality review');
  await approve(neha);
  await expect(statusBadge(neha)).toHaveText('State review');

  const farah = await loginAs(browser, 'Farah');
  await farah.goto(url);
  await approve(farah);
  await expect(statusBadge(farah)).toHaveText('Issued', { timeout: 30_000 });
  await expect(certRows(farah)).toHaveCount(60, { timeout: 30_000 });
});

test('return and resubmit: the centre sees the reason and round 2 starts at 0/2 approvals', async ({ browser }) => {
  const { anika, url, course } = await submittedBatch(browser, 'valid-10.csv', 10);
  const dev = await loginAs(browser, 'Dev');
  await dev.goto(url);
  await decideWithReason(dev, 'Return to centre', 'Phone numbers for two candidates look wrong');
  await expect(statusBadge(dev)).toHaveText('Returned');

  await anika.goto(url);
  await expect(anika.locator('.card-action .alert')).toContainText('Returned by Dev: Phone numbers for two candidates look wrong');
  await uploadCsv(anika, 'valid-10.csv', 10);
  await anika.getByRole('button', { name: 'Resubmit for review' }).click();
  await expect(statusBadge(anika)).toHaveText('District review');
  await expect(anika.locator('.head-meta')).toContainText('Round 2');

  await anika.goto('/batches?tab=all');
  const row = anika.locator('tbody tr', { hasText: course });
  await expect(row.locator('td').nth(4)).toHaveText('0/2');
  await expect(row.locator('td').nth(6)).toHaveText('2');
});

test('reject is final: the batch shows Rejected and no actions remain', async ({ browser }) => {
  const { anika, url } = await submittedBatch(browser, 'valid-10.csv', 10);
  const meera = await loginAs(browser, 'Meera');
  await meera.goto(url);
  await decideWithReason(meera, 'Reject', 'Centre is not accredited for this course');
  await expect(statusBadge(meera)).toHaveText('Rejected');
  for (const page of [meera, anika]) {
    await page.goto(url);
    await expect(statusBadge(page)).toHaveText('Rejected');
    for (const name of ['Approve', 'Return to centre', 'Reject', 'Upload CSV', 'Submit for review', 'Resubmit for review']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
  }
});

test('Download PDF serves application/pdf', async ({ browser }) => {
  const { anika } = await issuedBatch(browser);
  const [response, download] = await Promise.all([
    anika.waitForResponse((r) => /\/api\/certificates\/CF-[^/]+\/pdf$/.test(r.url())),
    anika.waitForEvent('download'),
    certRows(anika).first().getByRole('button', { name: 'Download PDF' }).click(),
  ]);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/pdf');
  expect(download.suggestedFilename()).toMatch(/^CF-[0-9A-HJKMNP-TV-Z]{10}\.pdf$/);
  expect(fs.readFileSync(await download.path()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('the sample CSV link downloads', async ({ browser }) => {
  const anika = await loginAs(browser, 'Anika');
  await createBatch(anika, `E2E samples ${Date.now()}`);
  const [download] = await Promise.all([anika.waitForEvent('download'), anika.getByRole('link', { name: 'valid-10' }).click()]);
  expect(download.suggestedFilename()).toBe('valid-10.csv');
  expect(fs.readFileSync(await download.path(), 'utf8').split('\n')[0].trim()).toBe('candidate_ref,full_name,phone,completion_date');
});
