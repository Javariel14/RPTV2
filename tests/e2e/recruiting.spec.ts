import { mkdir } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const visual = 'work/e1b-visual';
async function login(page: Page) {
  await page.goto('/crm/recruiting');
  const code = page.getByLabel('Código de sesión local');
  await expect(code).toBeVisible();
  await code.fill('recruiting-e2e-code');
  await page.getByRole('button', { name: 'Iniciar sesión local' }).click();
  const records = page.getByText('18 perfiles');
  const retry = page.getByRole('button', { name: 'Reintentar' });
  await expect(records.or(retry)).toBeVisible();
  if (await retry.isVisible()) await retry.click();
  await expect(records).toBeVisible();
}
async function openFirst(page: Page) {
  const trigger = page.locator('[data-focus-return]:visible').first();
  const id = await trigger.getAttribute('data-focus-return');
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  return { trigger, id: id! };
}
async function chooseAction(page: Page, value: string) {
  await page.getByRole('dialog').getByLabel('Guardar').selectOption(value);
}
async function submitAction(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('dialog').getByText('Cambio guardado')).toBeVisible();
}

test.beforeAll(async () => mkdir(visual, { recursive: true }));

test('persistent list, filters, lifecycle Kanban and authorized detail', async ({ page }) => {
  await login(page);
  await page.getByLabel('Tema', { exact: true }).selectOption('light');
  await expect(page.getByText('18 perfiles')).toBeVisible();
  await page.screenshot({ path: `${visual}/desktop-light-es-list.png`, fullPage: true });
  const search = page.getByLabel('Buscar personas');
  await search.fill('Persona sintética 001');
  await expect(page.getByRole('table').getByText('Persona sintética 001')).toBeVisible();
  await search.fill('');
  await page.getByLabel('Fuente').first().selectOption('event');
  await expect(page.getByRole('table').locator('tbody tr')).not.toHaveCount(0);
  await page.getByLabel('Fuente').first().selectOption('all');
  const { trigger } = await openFirst(page);
  await expect(page.getByRole('dialog').getByText('PII restringida')).toBeVisible();
  await expect(page.getByRole('dialog')).not.toContainText('@example');
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click();
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.locator('.recruiting-kanban section')).toHaveCount(10);
  await expect(page.locator('.recruiting-kanban')).toContainText('Persona sintética');
  const firstAdvance = page
    .locator('.recruiting-kanban section')
    .first()
    .getByRole('button', { name: 'Avanzar etapa' })
    .first();
  await firstAdvance.click();
  await expect(page.getByText('Cambio guardado')).toBeVisible();
});

test('all E1A actions persist and stale expectedVersion becomes conflict', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const { id } = await openFirst(page);
  await chooseAction(page, 'priority');
  await page.getByRole('dialog').getByLabel('Prioridad operativa').selectOption('C');
  await submitAction(page);
  await chooseAction(page, 'substatus');
  await page.getByRole('dialog').getByLabel('Subestado').selectOption('contacted');
  await submitAction(page);
  await chooseAction(page, 'appointment');
  await page.getByRole('dialog').getByLabel('Inicio').fill('2026-10-20T10:30');
  await submitAction(page);
  await expect(page.getByRole('dialog').getByText(/20 oct/)).toBeVisible();
  await chooseAction(page, 'interview');
  await page.getByRole('dialog').getByLabel('Fecha').fill('2026-10-21T11:00');
  await page.getByRole('dialog').getByLabel('Resultado').selectOption('attended');
  await page.getByRole('dialog').getByLabel('Notas').fill('Entrevista sintética');
  await submitAction(page);
  await chooseAction(page, 'followup');
  await page.getByRole('dialog').getByLabel('Vence').fill('2026-10-22T12:00');
  await page.getByRole('dialog').getByLabel('Siguiente acción').fill('Confirmar documentación');
  await submitAction(page);
  await chooseAction(page, 'complete_followup');
  await page
    .getByRole('dialog')
    .getByLabel('Seguimientos')
    .selectOption({ label: 'Confirmar documentación' });
  await submitAction(page);
  await chooseAction(page, 'hook');
  await page.getByRole('dialog').getByLabel('Tipo').selectOption('training');
  await page.getByRole('dialog').getByLabel('Referencia opcional').fill('cohorte-sintetica');
  await submitAction(page);
  await expect(page.getByRole('dialog')).toContainText('cohorte-sintetica');
  await chooseAction(page, 'reassign_owner');
  await page.getByRole('dialog').getByLabel('Responsable').selectOption({ label: 'Autorizado' });
  await submitAction(page);
  const detail = await page.evaluate(async (profileId) => {
    const response = await fetch(`/api/recruiting/profiles/${profileId}`);
    return ((await response.json()) as { data: { row: { version: number } } }).data;
  }, id);
  await page.evaluate(
    async ({ profileId, version }) => {
      await fetch(`/api/recruiting/profiles/${profileId}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          schemaVersion: 1,
          expectedVersion: version,
          command: { type: 'priority', priority: 'A' },
        }),
      });
    },
    { profileId: id, version: detail.row.version },
  );
  await chooseAction(page, 'substatus');
  await page.getByRole('dialog').getByLabel('Subestado').selectOption('evaluated');
  await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('dialog').getByText(/perfil cambió/)).toBeVisible();
});

test('forbidden and revocation are distinct from empty', async ({ page }) => {
  await login(page);
  await page.route('**/api/recruiting/context', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'FORBIDDEN' } }),
    }),
  );
  await page.getByLabel('Buscar personas').fill('revoked');
  await expect(page.getByRole('alert').getByText('Acceso denegado')).toBeVisible();
  await expect(page.getByText('Aún no hay perfiles de reclutamiento')).toHaveCount(0);
});

test('desktop wide Dark EN Kanban and Drawer passes axe', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.getByLabel('Idioma').selectOption('en');
  await page.getByLabel('Theme').selectOption('dark');
  await page.getByRole('button', { name: 'Kanban' }).click();
  await page.locator('.recruiting-kanban [data-focus-return]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByText(/operational priority/)).toBeVisible();
  await page.screenshot({
    path: `${visual}/desktop-wide-dark-en-kanban-drawer.png`,
    fullPage: true,
  });
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? '')),
  ).toEqual([]);
});

test('mobile 390 System FR main flow has no critical overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByLabel('Idioma').selectOption('fr');
  await page.getByLabel('Thème').selectOption('system');
  await page.locator('.mobile-list [data-focus-return]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByText(/priorité opérationnelle/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: `${visual}/mobile-system-fr-flow.png` });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('mobile 390 Dark PT forbidden state is explicit and accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/crm/recruiting');
  const code = page.getByLabel('Código de sesión local');
  await expect(code).toBeVisible();
  await code.fill('recruiting-e2e-code');
  await page.getByLabel('Idioma').selectOption('pt');
  await page.getByLabel('Tema').selectOption('dark');
  await page.route('**/api/recruiting/context', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'FORBIDDEN' } }),
    }),
  );
  await page.getByRole('button', { name: 'Iniciar sessão local' }).click();
  await expect(page.getByRole('alert').getByText('Acesso negado')).toBeVisible();
  await page.screenshot({ path: `${visual}/mobile-dark-pt-forbidden.png` });
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((item) => item.impact === 'critical')).toEqual([]);
});

test('E1 closure mobile System PT supports keyboard, authorized action and focus return', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await login(page);
  await page.getByLabel('Idioma').selectOption('pt');
  await page.getByLabel('Tema', { exact: true }).selectOption('system');
  const trigger = page.locator('.mobile-list [data-focus-return]').first();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/prioridade operacional/)).toBeVisible();
  await dialog.getByLabel('Salvar', { exact: true }).selectOption('priority');
  await dialog.getByLabel('Prioridade operacional').selectOption('B');
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(dialog.getByText('Alteração salva')).toBeVisible();
  await expect(dialog).not.toContainText(/interest_qualified|initial_contact|operational_priority/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).focus();
  expect(
    await dialog
      .getByRole('button', { name: 'Fechar', exact: true })
      .evaluate((node) => getComputedStyle(node).outlineStyle),
  ).not.toBe('none');
  expect(
    (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
      ['critical', 'serious'].includes(item.impact ?? ''),
    ),
  ).toEqual([]);
  await mkdir('work/e1-closure-visual', { recursive: true });
  await page.screenshot({ path: 'work/e1-closure-visual/recruiting-mobile-system-pt.png' });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
