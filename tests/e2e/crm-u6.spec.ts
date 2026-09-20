import { test, expect, type Locator, type Page } from '@playwright/test';
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
  await dialog.locator('form button[type="submit"]').click();
  await expect(dialog.getByRole('status').filter({ hasText: 'PostgreSQL' })).toBeVisible();
  await expect(dialog.getByLabel('Actions', { exact: true })).toBeVisible();
}

async function expectVisualHealth(page: Page, dialog?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (dialog)
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

test('U6 complete persistent vertical flow and representative Visual QA', async ({ page }) => {
  await mkdir('work/u6-visual', { recursive: true });
  await login(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('Tema', { exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await expectVisualHealth(page);
  await page.screenshot({ path: 'work/u6-visual/01-desktop-light-es-list.png', fullPage: true });

  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('Persona sintética 006');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Guardar vista', exact: true }).click();
  await page.getByLabel('Nombre de la vista').fill('U6 Vertical');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'U6 Vertical', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);

  await page.setViewportSize({ width: 1728, height: 1000 });
  await page.locator('.preferences select').first().selectOption('en');
  await page.locator('.preferences select').nth(1).selectOption('dark');
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  const card = page
    .locator('.crm-kanban .kanban-item')
    .filter({ hasText: 'Persona sintética 006' });
  await expect(card).toHaveCount(1);
  await card.click();
  const dialog = page.getByRole('dialog');
  const actions = dialog.getByLabel('Actions', { exact: true });
  await expect(actions).toBeVisible();

  await actions.selectOption('appointment');
  await dialog.locator('input[name="startsAt"]').fill('2026-09-22T10:00');
  await save(dialog);
  await actions.selectOption('demo');
  await dialog.locator('select[name="outcome"]').selectOption('purchase_intent_confirmed');
  await save(dialog);
  await actions.selectOption('quote');
  await dialog.locator('input[name="product"]').fill('U6 synthetic product');
  await dialog.locator('input[name="amount"]').fill('160.00');
  await save(dialog);
  await actions.selectOption('submit_order');
  await save(dialog);
  await actions.selectOption('reconcile_mock');
  await save(dialog);
  await expect(dialog.getByText('Won — simulation', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Manual reconciliation', { exact: false })).toBeVisible();
  await expectVisualHealth(page, dialog);
  await page.screenshot({
    path: 'work/u6-visual/02-desktop-wide-dark-en-kanban-drawer.png',
    fullPage: false,
  });

  await actions.selectOption('delivery');
  await save(dialog);
  await actions.selectOption('curation');
  await save(dialog);
  await expect(dialog.getByText('Cured — simulation', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(card).toBeFocused();

  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.locator('.preferences select').first().selectOption('fr');
  await page.locator('.preferences select').nth(1).selectOption('system');
  await page.locator('.mode-toggle button').first().click();
  const mobileTrigger = page
    .locator('.mobile-list article button')
    .filter({ hasText: 'Persona sintética 006' });
  await mobileTrigger.click();
  await expect(dialog.getByText('Préparée — simulation', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Simulation locale.', { exact: false })).toBeVisible();
  await expectVisualHealth(page, dialog);
  await page.screenshot({
    path: 'work/u6-visual/03-mobile-system-fr-main-flow.png',
    fullPage: false,
  });
  await page.keyboard.press('Escape');
  await expect(mobileTrigger).toBeFocused();

  const detailPattern = /\/api\/crm\/opportunities\/[0-9a-f-]+$/;
  await page.locator('.preferences select').first().selectOption('pt');
  await page.locator('.preferences select').nth(1).selectOption('dark');
  await page.route(detailPattern, (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }),
  );
  await mobileTrigger.click();
  await expect(dialog.getByRole('alert')).toContainText('Indisponível ou sem permissão.');
  await expect(dialog.locator('form')).toHaveCount(0);
  await expect(dialog.getByText('Sem registros acessíveis', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/@|\+000/)).toHaveCount(0);
  await expectVisualHealth(page, dialog);
  await page.screenshot({
    path: 'work/u6-visual/04-mobile-dark-pt-forbidden.png',
    fullPage: false,
  });
  await page.keyboard.press('Escape');
  await expect(mobileTrigger).toBeFocused();
});
