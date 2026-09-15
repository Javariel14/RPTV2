import { test, expect, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';

async function login(page: Page) {
  await page.goto('/crm/commercial');
  await page.getByLabel('Código de sesión local').fill('u3-synthetic-test-session');
  await page.getByRole('button', { name: 'Iniciar sesión local', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
}
async function save(dialog: Locator) {
  const confirm = dialog.getByRole('checkbox');
  if (await confirm.count()) await confirm.check();
  await dialog.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Cambio confirmado en PostgreSQL' }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Acciones', { exact: true })).toBeVisible();
}
test('U4 persisted Kanban → detail → complete simulated order, notes and contact', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  await expect(page.locator('.crm-kanban > section')).toHaveCount(9);
  const column = page.getByRole('region', { name: 'Nuevo', exact: true });
  // A per-stage page is loaded independently of the grid page.
  await expect(
    page.locator('.crm-kanban .kanban-item').filter({ hasText: 'Persona sintética 002' }),
  ).toBeVisible();
  await page
    .locator('.crm-kanban .kanban-item')
    .filter({ hasText: 'Persona sintética 002' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Acciones', { exact: true })).toBeVisible();
  await expect(dialog).toHaveCSS('width', '460px');
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('appointment');
  await dialog.getByLabel('Fecha y hora', { exact: true }).fill('2026-09-20T10:00');
  await save(dialog);
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('demo');
  await dialog.getByLabel('Resultado', { exact: true }).selectOption('purchase_intent_confirmed');
  await save(dialog);
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('quote');
  await dialog.getByLabel('Producto sintético').fill('U4 Synthetic product');
  await dialog.getByLabel('Importe simulado').fill('100.00');
  await save(dialog);
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('submit_order');
  await save(dialog);
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('reconcile_mock');
  await save(dialog);
  await expect(dialog.getByText('Ganada — simulación', { exact: true })).toBeVisible();
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('delivery');
  await save(dialog);
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('curation');
  await save(dialog);
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('entry');
  await dialog.getByLabel('Tipo', { exact: true }).selectOption('task');
  await dialog.getByLabel('Texto', { exact: true }).fill('U4 follow-up');
  await save(dialog);
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('complete_task');
  await save(dialog);
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('edit_contact');
  await dialog.getByLabel('Correo', { exact: true }).fill('browser-u4@example.invalid');
  await dialog.getByLabel('Teléfono', { exact: true }).fill('+000002');
  await save(dialog);
  await expect(dialog.getByText('Curada — simulación', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await page.reload();
  await page.locator('tbody .person').filter({ hasText: 'Persona sintética 002' }).click();
  await expect(
    dialog.getByText('Correo: browser-u4@example.invalid', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('Curada — simulación', { exact: true })).toBeVisible();
  await expect(dialog.getByText('U4 follow-up', { exact: false })).toContainText('✓');
  await expect(column).toHaveCount(0); // table after reload, not an alternate dashboard
});

test('U4 Kanban pagination/filter/saved view; mobile/desktop themes/locales and axe evidence', async ({
  page,
}) => {
  await login(page);
  await mkdir('work/u4-visual', { recursive: true });
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  const newColumn = page.locator('.crm-kanban > section').first();
  await expect(newColumn.locator('.kanban-item')).toHaveCount(20);
  await newColumn.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await expect(newColumn.locator('.kanban-item')).not.toHaveCount(20);
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('Persona sintética 003');
  await expect(page.locator('.crm-kanban .kanban-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Guardar vista', exact: true }).click();
  await page.getByLabel('Nombre de la vista').fill('U4 Kanban');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'U4 Kanban', exact: true }).click();
  await expect(page.locator('.crm-kanban .kanban-item')).toHaveCount(1);
  for (const width of [1440, 390])
    for (const theme of ['light', 'dark', 'system']) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByLabel('Tema', { exact: true }).selectOption(theme);
      await page.locator('.crm-kanban .kanban-item').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Acciones', { exact: true })).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      await page.screenshot({
        path: `work/u4-visual/drawer-${theme}-${width}.png`,
        fullPage: false,
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await page.screenshot({
        path: `work/u4-visual/kanban-${theme}-${width}.png`,
        fullPage: true,
      });
    }
  for (const locale of ['en', 'fr', 'pt', 'es']) {
    await page
      .locator('select')
      .filter({ has: page.locator('option[value="en"]') })
      .selectOption(locale);
    await page.locator('.crm-kanban .kanban-item').click();
    await expect(page.locator('.crm-detail form')).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `work/u4-visual/drawer-${locale}-390.png`, fullPage: false });
    await page.keyboard.press('Escape');
  }
});

test('U4 detail error states and conflict never fall back to fixtures or stale PII', async ({
  page,
  context,
}) => {
  await login(page);
  const detailPattern = /\/api\/crm\/opportunities\/[0-9a-f-]+$/;
  for (const status of [403, 404, 503]) {
    await page.route(detailPattern, (r) =>
      r.fulfill({ status, contentType: 'application/json', body: '{}' }),
    );
    await page.locator('tbody .person').filter({ hasText: 'Persona sintética 003' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.locator('form')).toHaveCount(0);
    await expect(dialog.getByText('Persona sintética 003', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.unroute(detailPattern);
  }
  await page.locator('tbody .person').filter({ hasText: 'Persona sintética 003' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('form')).toBeVisible();
  await page.route('**/commands', (r) =>
    r.fulfill({ status: 409, contentType: 'application/json', body: '{}' }),
  );
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('El registro cambió');
  await expect(dialog.getByRole('button', { name: 'Guardar', exact: true })).toBeDisabled();
  await page.unroute('**/commands');
  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(dialog.locator('form')).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toContainText('No disponible o sin permiso');
});

test('U4 mobile action retries a lost response with the same receipt and no duplicate', async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('.mobile-list article button')
    .filter({ hasText: 'Persona sintética 003' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Acciones', { exact: true }).selectOption('entry');
  await dialog.getByLabel('Texto', { exact: true }).fill('U4 mobile exactly once');
  let originalBody = '',
    originalKey = '';
  await page.route('**/commands', async (route) => {
    originalBody = route.request().postData() ?? '';
    originalKey = route.request().headers()['idempotency-key'] ?? '';
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await dialog.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.locator('form')).toHaveCount(0);
  await page.unroute('**/commands');
  const retry = page.waitForRequest('**/commands');
  await dialog.getByRole('button', { name: 'Reintentar', exact: true }).click();
  const request = await retry;
  expect(request.postData()).toBe(originalBody);
  expect(request.headers()['idempotency-key']).toBe(originalKey);
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Cambio confirmado en PostgreSQL' }),
  ).toBeVisible();
  await expect(dialog.getByText('Nota · U4 mobile exactly once', { exact: true })).toHaveCount(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
