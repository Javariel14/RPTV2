import { mkdir } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const visual = 'work/e2d-visual';
test.beforeAll(async () => mkdir(visual, { recursive: true }));
async function login(page: Page) {
  await page.goto('/field');
  await page.getByTestId('field-session-code').fill('field-e2e-code');
  await page.getByTestId('field-session-submit').click();
  await expect(page.locator('.field-list article').first()).toBeVisible();
}

test('desktop Light ES list, filters and authorized detail', async ({ page }) => {
  await login(page);
  await page.getByLabel('Tema').selectOption('light');
  await expect(page.locator('.field-list article')).toHaveCount(1);
  await page.locator('.field-list [data-focus-return]').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Visita comercial sintética');
  await expect(dialog).toContainText('Destino sintético');
  await expect(dialog).toContainText('Abrir Agenda');
  await page.screenshot({ path: `${visual}/desktop-light-es-detail.png`, fullPage: true });
  await dialog.getByRole('button', { name: 'Cerrar' }).click();
  await page.getByLabel('Estado').selectOption('completed');
  await expect(
    page.getByRole('heading', { name: 'Sin resultados para estos filtros' }),
  ).toBeVisible();
  await page.getByLabel('Estado').selectOption('all');
  await page.getByRole('button', { name: 'Próximas' }).first().click();
  await expect(page.locator('.field-list article')).toHaveCount(2);
});

test('check-in handles denied location, retry and check-out persist', async ({ page }) => {
  await login(page);
  await page.locator('.field-list [data-focus-return]').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Solicitar ubicación para esta acción').check();
  await dialog.getByRole('button', { name: 'Iniciar visita' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(dialog).toContainText('En curso');
  await expect(dialog.locator('.agenda-history').getByText('Inicio registrado')).toHaveCount(1);
  await expect(dialog).toContainText('No se obtuvo ubicación');
  await dialog.getByLabel('Resultado').fill('Seguimiento acordado');
  await dialog.getByRole('button', { name: 'Finalizar visita' }).click();
  await dialog.getByRole('button', { name: 'Confirmar cierre' }).click();
  await expect(dialog).toContainText('Completada');
  await expect(dialog).toContainText('Seguimiento acordado');
  await expect(dialog.getByText('Cambio guardado')).toBeVisible();
  await page.screenshot({ path: `${visual}/checkin-checkout.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('.field-list [data-focus-return]').first()).toBeFocused();
});

test('server-rejected optional location leaves visit usable for an explicit retry', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (success: PositionCallback) =>
          success({
            coords: { latitude: -0.18, longitude: -78.47, accuracy: 20 },
            timestamp: Date.now(),
          } as GeolocationPosition),
      },
    });
  });
  await login(page);
  await page.getByRole('button', { name: 'Nueva visita' }).first().click();
  await page.getByRole('dialog').getByLabel('Propósito').fill('Ubicación opcional E2D');
  await page.getByRole('dialog').getByRole('button', { name: 'Nueva visita' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Ubicación opcional E2D');
  await dialog.getByLabel('Solicitar ubicación para esta acción').check();
  let rejected = false;
  await page.route('**/api/field/*/commands', async (route) => {
    const body = route.request().postDataJSON() as { command?: { location?: unknown } };
    if (!rejected && body.command?.location) {
      rejected = true;
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'FORBIDDEN' } }),
      });
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Puedes reintentar sin ella');
  await expect(dialog.getByLabel('Solicitar ubicación para esta acción')).not.toBeChecked();
  await expect(dialog).toContainText('Planificada');
  await dialog.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(dialog).toContainText('En curso');
  await expect(dialog.locator('.agenda-history').getByText('Inicio registrado')).toHaveCount(1);
});

test('desktop wide Dark EN create, update and cancel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await login(page);
  await page.getByLabel('Idioma').selectOption('en');
  await page.getByLabel('Theme').selectOption('dark');
  await page.getByRole('button', { name: 'New visit' }).first().click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Purpose').fill('Synthetic review E2D');
  await createDialog.getByRole('button', { name: 'New visit' }).click();
  await expect(page.getByRole('dialog')).toContainText('Synthetic review E2D');
  await page.getByRole('dialog').getByLabel('Purpose').fill('Synthetic updated E2D');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toContainText('Change saved');
  await page.screenshot({ path: `${visual}/desktop-dark-en-drawer.png`, fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel visit' }).click();
  await expect(page.getByRole('dialog')).toContainText('Cancelled');
});

test('no-show persists and a version conflict is announced without false success', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Nueva visita' }).first().click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Propósito').fill('Ausencia sintética E2D');
  await dialog.getByRole('button', { name: 'Nueva visita' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Ausencia sintética E2D');
  await dialog.getByRole('button', { name: 'Marcar no asistió' }).click();
  await expect(dialog).toContainText('No asistió');
  await dialog.getByRole('button', { name: 'Cerrar' }).click();
  await page.getByRole('button', { name: 'Nueva visita' }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Propósito').fill('Conflicto sintético E2D');
  await dialog.getByRole('button', { name: 'Nueva visita' }).click();
  await expect(dialog).toContainText('Conflicto sintético E2D');
  await page.route('**/api/field/*/commands', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'CONFLICT' } }),
    });
  });
  await dialog.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(dialog.getByRole('alert')).toContainText('La visita cambió');
  await expect(dialog.getByText('Cambio guardado')).toHaveCount(0);
});

test('mobile 390 System FR is action-first and accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByLabel('Idioma').selectOption('fr');
  await page.getByLabel('Thème').selectOption('system');
  const seededVisit = page
    .locator('.field-list article')
    .filter({ has: page.getByText('Visita comercial sintética', { exact: true }) });
  await expect(seededVisit).toHaveCount(1);
  await seededVisit.getByRole('button').click();
  await expect(page.getByRole('dialog')).toContainText('Visita comercial sintética');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${visual}/mobile-system-fr.png` });
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? '')),
  ).toEqual([]);
});

test('mobile 390 Dark PT forbidden is distinct from empty', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/field');
  await page.getByTestId('field-session-code').fill('field-e2e-code');
  await page.getByLabel('Idioma').selectOption('pt');
  await page.getByLabel('Tema').selectOption('dark');
  await page.route('**/api/field/visits?*', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'FORBIDDEN' } }),
    }),
  );
  await page.getByTestId('field-session-submit').click();
  await expect(page.locator('section.state[role="alert"]')).toContainText('Acesso negado');
  await expect(page.getByText('Ainda não há visitas')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${visual}/mobile-dark-pt-forbidden.png` });
});
