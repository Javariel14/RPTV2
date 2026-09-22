import { mkdir } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const visual = 'work/e2b-visual';
async function login(page: Page) {
  await page.goto('/agenda');
  const code = page.getByLabel('Código de sesión local');
  await expect(code).toBeVisible();
  await code.fill('agenda-e2e-code');
  await page.getByRole('button', { name: 'Iniciar sesión local' }).click();
  await expect(page.locator('.agenda-list article')).toHaveCount(2);
}

test.beforeAll(async () => mkdir(visual, { recursive: true }));

test('Today, Week and detail use persistent authorized items', async ({ page }) => {
  await login(page);
  await page.getByLabel('Tema').selectOption('light');
  await expect(page.locator('.agenda-list article')).toHaveCount(2);
  await page.locator('.agenda-list [data-focus-return]').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('America/Guayaquil');
  await expect(dialog).toContainText('Recordatorio interno RPT');
  await dialog.getByRole('button', { name: 'Cerrar' }).click();
  await page.getByRole('button', { name: 'Semana' }).click();
  await expect(page.locator('.agenda-week')).toBeVisible();
  await expect(page.locator('.agenda-week section')).toHaveCount(7);
  await page.locator('.agenda-week [data-focus-return]').first().click();
  await expect(page.getByRole('dialog')).toContainText('America/Guayaquil');
  await page.screenshot({ path: `${visual}/desktop-light-es-week-detail.png`, fullPage: true });
});

test('confirm, reschedule, reminders and task completion persist without duplicate UI items', async ({
  page,
}) => {
  await login(page);
  const appointment = page
    .locator('.agenda-list article')
    .filter({ hasText: 'Revisión comercial' });
  await appointment.getByRole('button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Confirmar' }).click();
  await expect(dialog.getByText('Cambio guardado')).toBeVisible();
  await expect(dialog).toContainText('Confirmada');
  await dialog.getByLabel('Inicio').fill(`${new Date().toISOString().slice(0, 10)}T12:00`);
  await dialog.getByLabel('Fin').fill(`${new Date().toISOString().slice(0, 10)}T13:00`);
  await dialog.getByRole('button', { name: 'Guardar', exact: true }).first().click();
  await expect(dialog.getByText('Cambio guardado')).toBeVisible();
  await dialog.getByLabel('1 hora antes').check();
  await dialog.locator('fieldset').getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog.getByText('Cambio guardado')).toBeVisible();
  await page.screenshot({ path: `${visual}/reschedule-confirmation-flow.png`, fullPage: true });
  await dialog.getByRole('button', { name: 'Cerrar' }).click();
  await expect(
    page.locator('.agenda-list article').filter({ hasText: 'Revisión comercial' }),
  ).toHaveCount(1);
  await page
    .locator('.agenda-list article')
    .filter({ hasText: 'Preparar seguimiento' })
    .getByRole('button')
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Completar tarea' }).click();
  await expect(page.getByRole('dialog')).toContainText('Completada');
});

test('create recurrence, travel and timezone through the supported core contract', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Nuevo elemento' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Título').fill('Serie sintética E2B');
  await dialog.getByLabel('Inicio').fill('2026-11-02T09:00');
  await dialog.getByLabel('Fin').fill('2026-11-02T10:00');
  await dialog.getByLabel('Zona horaria').fill('America/New_York');
  await dialog.getByLabel('Recurrencia').selectOption('weekly');
  await dialog.getByLabel('Hasta').fill('2026-11-16');
  await dialog.getByLabel('Origen').fill('Oficina sintética');
  await dialog.getByLabel('Destino/dirección').fill('Destino sintético');
  await dialog.getByLabel('Minutos de traslado').fill('25');
  await dialog.getByLabel('Minutos de preparación').fill('10');
  await dialog.getByLabel('15 minutos antes').check();
  await dialog.getByRole('button', { name: 'Crear cita' }).click();
  await expect(page.getByRole('dialog')).toContainText('Serie sintética E2B');
  await expect(page.getByRole('dialog')).toContainText('America/New_York');
});

test('desktop Dark EN list and mobile System FR remain accessible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.getByLabel('Idioma').selectOption('en');
  await page.getByLabel('Theme').selectOption('dark');
  await page.getByRole('button', { name: 'Agenda list' }).click();
  await expect(page.locator('.agenda-list article').first()).toBeVisible();
  await page.screenshot({ path: `${visual}/desktop-dark-en-list.png`, fullPage: true });
  let results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? '')),
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Language').selectOption('fr');
  await page.getByLabel('Thème').selectOption('system');
  await page.locator('.agenda-list [data-focus-return]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('America/Guayaquil');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${visual}/mobile-system-fr-detail.png` });
  results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? '')),
  ).toEqual([]);
  await page.keyboard.press('Escape');
});

test('mobile Dark PT forbidden is distinct from empty', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/agenda');
  await page.getByLabel('Código de sesión local').fill('agenda-e2e-code');
  await page.getByLabel('Idioma').selectOption('pt');
  await page.getByLabel('Tema').selectOption('dark');
  await page.route('**/api/agenda/items**', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'FORBIDDEN' } }),
    }),
  );
  await page.getByRole('button', { name: 'Iniciar sessão local' }).click();
  await expect(page.locator('section.state[role="alert"]')).toContainText('Acesso negado');
  await expect(page.getByText('Ainda não há itens')).toHaveCount(0);
  await page.screenshot({ path: `${visual}/mobile-dark-pt-forbidden.png` });
});
