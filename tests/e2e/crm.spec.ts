import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';

async function login(page: Page) {
  await page.goto('/crm/commercial');
  await page.getByLabel('Código de sesión local').fill('u3-synthetic-test-session');
  await page.getByRole('button', { name: 'Iniciar sesión local', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
}
test('U3 database → API → grid; filters, paging, columns and saved configuration survive reload', async ({
  page,
}) => {
  await login(page);
  await expect(page.getByText('45 oportunidades', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Añadir ejemplo ficticio' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await expect(page.locator('tbody tr').first()).toContainText('Persona sintética 021');
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('Persona sintética 045');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Densidad', { exact: true }).selectOption('compact');
  await page.getByLabel('Mostrar origen', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Filtros · 1', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('combobox', { name: 'Prioridad', exact: true }).selectOption('normal');
  await sheet.getByRole('combobox', { name: 'Ordenar por', exact: true }).selectOption('due');
  await sheet.getByRole('combobox', { name: 'Dirección', exact: true }).selectOption('desc');
  await sheet.getByRole('checkbox', { name: 'Responsable', exact: true }).uncheck();
  await sheet.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
  await page.getByRole('button', { name: 'Guardar vista', exact: true }).click();
  await page.getByLabel('Nombre de la vista').fill('Vista U3 persistente');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByText('Vista guardada en PostgreSQL', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.getByRole('button', { name: 'Vista U3 persistente', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByLabel('Buscar oportunidades', { exact: true })).toHaveValue(
    'Persona sintética 045',
  );
  await expect(page.getByLabel('Densidad', { exact: true })).toHaveValue('compact');
  await expect(page.getByLabel('Mostrar origen', { exact: true })).not.toBeChecked();
  await expect(page.getByRole('columnheader', { name: 'Responsable', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Filtros · 2', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('combobox', { name: 'Ordenar por', exact: true }),
  ).toHaveValue('due');
  await expect(
    page.getByRole('dialog').getByRole('combobox', { name: 'Dirección', exact: true }),
  ).toHaveValue('desc');
  await mkdir('work/u3-visual', { recursive: true });
  await page.screenshot({ path: 'work/u3-visual/restored-view-filters.png', fullPage: true });
});

test('U3 visual evidence: real data, two themes, desktop/mobile, four locales, axe', async ({
  page,
}) => {
  await login(page);
  await mkdir('work/u3-visual', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.getByLabel('Tema', { exact: true }).selectOption(theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(page.locator(width === 390 ? '.mobile-list article' : 'tbody tr')).toHaveCount(
        20,
      );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      const result = await new AxeBuilder({ page }).analyze();
      expect(result.violations).toEqual([]);
      await page.screenshot({ path: `work/u3-visual/${theme}-${width}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const locale of ['en', 'fr', 'pt', 'es']) {
    await page.locator('.preferences select').first().selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ path: `work/u3-visual/locale-${locale}-390.png`, fullPage: true });
  }
});

test('U3 errors never expose stale rows or fixtures; session/CSRF boundary', async ({
  page,
  context,
}) => {
  await login(page);
  const csrf = await context.request.post('/api/crm/views', { data: {} });
  expect(csrf.status()).toBe(403);
  await page.route('**/api/crm/opportunities?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UNAVAILABLE' } }),
    }),
  );
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('failure');
  await expect(page.getByRole('heading', { name: 'No pudimos cargar esta vista' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.unroute('**/api/crm/opportunities?*');
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('');
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.route('**/api/crm/opportunities?*', (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }),
  );
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('denied');
  await expect(page.getByRole('heading', { name: 'Acceso no disponible' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.unroute('**/api/crm/opportunities?*');
  await context.clearCookies();
  await page.reload();
  await expect(page.getByLabel('Código de sesión local')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(0);
});
