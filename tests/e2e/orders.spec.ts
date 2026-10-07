import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { exactAmount } from '../../apps/web/app/order-view-model.js';

async function login(page: Page) {
  await page.goto('/orders');
  await page.getByLabel('Código de sesión local').fill('orders-e2e');
  await page.getByRole('button', { name: 'Iniciar sesión local' }).click();
  await expect(page.locator('.order-table tbody tr')).toHaveCount(10);
}
async function accessibility(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
  ).toEqual([]);
}
test('DB-backed list, exact search, status and opaque forward/back pagination', async ({
  page,
}) => {
  await login(page);
  expect(await page.evaluate(() => document.cookie.includes('rpt.crm-session'))).toBe(false);
  expect(
    (await page.context().cookies()).find((cookie) => cookie.name === 'rpt.crm-session')?.httpOnly,
  ).toBe(true);
  expect(await page.evaluate(() => /Bearer|eyJ/.test(JSON.stringify(localStorage)))).toBe(false);
  const first = await page.locator('.order-table .order-number').allTextContents();
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await expect(page.locator('.order-table tbody tr')).toHaveCount(2);
  const tail = await page.locator('.order-table .order-number').allTextContents();
  expect(new Set([...first, ...tail]).size).toBe(12);
  await page.getByRole('button', { name: 'Anterior', exact: true }).click();
  await expect(page.locator('.order-table .order-number')).toHaveText(first);
  await page.getByLabel('Número de orden exacto').fill(first[0]!);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.locator('.order-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.order-table .order-number')).toHaveText(first[0]!);
  await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();
  await page.getByRole('combobox', { name: 'Estado', exact: true }).selectOption('cancelled');
  await expect(page.locator('.order-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.order-table')).toContainText('Cancelada');
  await page.getByRole('combobox', { name: 'Estado', exact: true }).selectOption('superseded');
  await expect(page.locator('.order-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.order-table')).toContainText('Reemplazada');
});
test('keyboard detail uses real immutable snapshot, financing, provenance and lifecycle', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('combobox', { name: 'Estado', exact: true }).selectOption('cancelled');
  const link = page.locator('.order-table .order-number');
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute('href');
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(href!));
  await expect(page.getByText('Snapshot aceptado e inmutable.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Financiamiento aceptado' })).toBeVisible();
  await expect(page.locator('.order-lines article')).not.toHaveCount(0);
  await expect(page.locator('.order-history li')).toHaveCount(2);
  await expect(page.locator('.order-history')).toContainText('Cancelación registrada');
  const response = await page.request.get(`/api${href}`);
  const { data } = await response.json();
  await expect(page.locator('.order-totals')).toContainText(
    exactAmount(
      data.commercialSnapshot.totals.grandTotal,
      data.currency,
      data.commercialSnapshot.minorUnits,
    ),
  );
  await expect(page.getByText(data.calculationHash, { exact: true })).toBeVisible();
  expect(await page.getByRole('button', { name: /^(Editar|Cancelar|Reemplazar)$/ }).count()).toBe(
    0,
  );
  await accessibility(page);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Órdenes', exact: true })).toBeVisible();
});
test('desktop and tablet accessibility, mobile cards/detail without horizontal overflow', async ({
  page,
}) => {
  await login(page);
  await accessibility(page);
  await page.screenshot({ path: 'work/orders-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 768, height: 1024 });
  await accessibility(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.order-table')).toBeHidden();
  await expect(page.locator('.order-cards article')).toHaveCount(10);
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(await overflow()).toBe(false);
  await page.screenshot({ path: 'work/orders-mobile.png', fullPage: true });
  await accessibility(page);
  await page.locator('.order-cards .order-number').first().click();
  await expect(
    page.getByRole('heading', { name: 'Condiciones comerciales aceptadas' }),
  ).toBeVisible();
  expect(await overflow()).toBe(false);
  await accessibility(page);
});
test('empty result and missing/unknown session are safe', async ({ page }) => {
  await page.goto('/orders');
  await expect(page.getByText('Sesión local requerida', { exact: true })).toBeVisible();
  await login(page);
  await page.getByLabel('Número de orden exacto').fill('ORD-9999999999');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.getByText('No hay órdenes disponibles', { exact: true })).toBeVisible();
  await page.goto('/orders/00000000-0000-4000-8000-000000000000');
  await expect(
    page.getByText('No encontramos esta orden o no tienes acceso.', { exact: true }),
  ).toBeVisible();
});
test('deterministic 422/503 states never render upstream internals', async ({ page }) => {
  for (const status of [422, 503]) {
    await page.route('**/api/orders?**', (route) =>
      route.fulfill({
        status,
        headers: { 'X-Request-Id': 'safe-request-reference' },
        contentType: 'application/json',
        body: JSON.stringify({ internal: 'SECRET SQL STACK' }),
      }),
    );
    await page.goto('/orders');
    await expect(
      page.getByText(status === 422 ? 'Solicitud no válida' : 'Servicio no disponible', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText('Referencia de solicitud: safe-request-reference')).toBeVisible();
    await expect(page.getByText('SECRET SQL STACK')).toHaveCount(0);
    await page.unroute('**/api/orders?**');
  }
});

test('history appends real cursor pages once and a denied refresh clears protected detail', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('combobox', { name: 'Estado', exact: true }).selectOption('cancelled');
  const link = page.locator('.order-table .order-number');
  await expect(link).toHaveCount(1);
  const href = (await link.getAttribute('href'))!;
  await page.route(`**/api${href}/history?**`, async (route) => {
    const url = new URL(route.request().url());
    // Real DB-generated cursors, with small pages solely to exercise append behavior.
    url.searchParams.set('limit', '1');
    const response = await route.fetch({ url: url.href });
    await route.fulfill({ response });
  });
  await link.click();
  await expect(page.locator('.order-history li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Cargar más historial' }).click();
  await expect(page.locator('.order-history li')).toHaveCount(2);
  await expect(page.locator('.order-history .order-eyebrow')).toHaveText([
    'Secuencia 1',
    'Secuencia 2',
  ]);
  await expect(page.getByRole('button', { name: 'Cargar más historial' })).toHaveCount(0);
  await page.route(`**/api${href}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"schemaVersion":1,"error":{"code":"NOT_FOUND"}}',
    }),
  );
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await expect(
    page.getByText('No encontramos esta orden o no tienes acceso.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.order-snapshot')).toHaveCount(0);
  await expect(page.locator('.order-history')).toHaveCount(0);
});

test('history pagination denial clears all protected data and rejects a late detail response', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const transport = window.fetch;
    // Exercise a late completion even when a transport ignores cancellation.
    window.fetch = (input, options) => transport(input, { ...options, signal: null });
  });
  await login(page);
  await page.getByRole('combobox', { name: 'Estado', exact: true }).selectOption('cancelled');
  const link = page.locator('.order-table .order-number');
  const href = (await link.getAttribute('href'))!;
  await page.route(`**/api${href}/history?**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('cursor'))
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    url.searchParams.set('limit', '1');
    await route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
  await link.click();
  await expect(page.locator('.order-history li')).toHaveCount(1);
  await expect(page.locator('.order-lines article')).not.toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Financiamiento aceptado' })).toBeVisible();
  const held = await page.request.get(`/api${href}`);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(`**/api${href}`, async (route) => {
    arrived();
    await pending;
    await route.fulfill({ response: held }).catch(() => {}); // Request may already be aborted.
  });
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await started;
  await page.getByRole('button', { name: 'Cargar más historial' }).click();
  await expect(
    page.getByText('No encontramos esta orden o no tienes acceso.', { exact: true }),
  ).toBeVisible();
  release();
  await expect(
    page.locator(
      '.order-snapshot, .order-lines, .order-totals, .order-history, .order-detail-grid',
    ),
  ).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Financiamiento aceptado' })).toHaveCount(0);
  await page.waitForTimeout(200);
  await expect(page.locator('.order-snapshot, .order-history')).toHaveCount(0);
});

test('transient history failure preserves the readable snapshot and can retry', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('combobox', { name: 'Estado', exact: true }).selectOption('cancelled');
  const link = page.locator('.order-table .order-number');
  const href = (await link.getAttribute('href'))!;
  let unavailable = true;
  let invalidCursor = true;
  await page.route(`**/api${href}/history?**`, async (route) => {
    if (unavailable)
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    const url = new URL(route.request().url());
    url.searchParams.set('limit', '1');
    if (invalidCursor && url.searchParams.has('cursor')) url.searchParams.set('cursor', 'A');
    await route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
  await link.click();
  await expect(page.getByText('Servicio no disponible', { exact: true })).toBeVisible();
  await expect(page.locator('.order-snapshot')).toBeVisible();
  unavailable = false;
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await expect(page.locator('.order-history li')).not.toHaveCount(0);
  await page.getByRole('button', { name: 'Cargar más historial' }).click();
  await expect(page.getByText('Solicitud no válida', { exact: true })).toBeVisible();
  invalidCursor = false;
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await expect(page.getByText('Solicitud no válida', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cargar más historial' }).click();
  await expect(page.locator('.order-history li')).toHaveCount(2);
  await expect(page.locator('.order-snapshot')).toBeVisible();
});

test('initial history denial clears detail while transient detail failure retains it', async ({
  page,
}) => {
  await login(page);
  const href = (await page.locator('.order-table .order-number').first().getAttribute('href'))!;
  await page.route(`**/api${href}/history?**`, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  );
  await page.goto(href);
  await expect(
    page.getByText('No encontramos esta orden o no tienes acceso.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.order-snapshot,.order-history,.order-detail-grid')).toHaveCount(0);
  await page.unroute(`**/api${href}/history?**`);
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await expect(page.locator('.order-snapshot')).toBeVisible();
  await page.route(`**/api${href}`, (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
  );
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await expect(page.getByText('Servicio no disponible', { exact: true })).toBeVisible();
  await expect(page.locator('.order-snapshot')).toBeVisible();
});

test('returning to a previously denied list query rechecks the current server session', async ({
  page,
}) => {
  await page.goto('/orders');
  await expect(page.getByText('Sesión local requerida', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch('/api/crm/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'orders-e2e' }),
          })
        ).status,
    ),
  ).toBe(204);
  await page.getByRole('combobox', { name: 'Estado', exact: true }).selectOption('cancelled');
  await expect(page.locator('.order-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();
  await expect(page.locator('.order-table tbody tr')).toHaveCount(10);
});
