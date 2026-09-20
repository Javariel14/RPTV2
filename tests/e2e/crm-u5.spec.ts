import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';

async function login(page: Page) {
  await page.goto('/crm/commercial');
  await page.getByLabel('Código de sesión local').fill('u3-synthetic-test-session');
  await page.getByRole('button', { name: 'Iniciar sesión local', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  expect(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('button, input, select, textarea'))
        .filter((element) => element.offsetParent !== null)
        .every((element) => {
          const box = element.getBoundingClientRect();
          return box.left >= 0 && box.right <= window.innerWidth;
        }),
    ),
  ).toBe(true);
}

test('U5 responsive list, Kanban and Drawer retain an action-first accessible layout', async ({
  page,
}) => {
  await login(page);
  await mkdir('work/u5-visual', { recursive: true });
  for (const width of [320, 390, 768, 1024, 1280, 1440, 1728]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(
      width < 1024 ? page.locator('.mobile-list article') : page.locator('tbody tr'),
    ).toHaveCount(20);
    await expectNoHorizontalOverflow(page);
    if ([320, 768, 1440].includes(width))
      await page.screenshot({ path: `work/u5-visual/list-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const trigger = page.locator('tbody .person').filter({ hasText: 'Persona sintética 003' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCSS('width', '460px');
  await expect(dialog.getByRole('button', { name: 'Cerrar', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('.mobile-list article button')
    .filter({ hasText: 'Persona sintética 003' })
    .click();
  await expect(dialog.getByLabel('Acciones', { exact: true })).toBeVisible();
  await expect(dialog).toHaveCSS('width', '390px');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: 'work/u5-visual/drawer-mobile.png', fullPage: false });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  await expect(page.locator('.crm-kanban > section')).toHaveCount(9);
  await expect(page.locator('.crm-kanban > section').first().locator('.kanban-item')).toHaveCount(
    20,
  );
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: 'work/u5-visual/kanban-mobile.png', fullPage: true });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('U5 themes, locales, reduced motion and keyboard focus are verified without fixture fallback', async ({
  page,
}) => {
  await login(page);
  await mkdir('work/u5-visual', { recursive: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  for (const theme of ['light', 'dark']) {
    await page.getByLabel('Tema', { exact: true }).selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ path: `work/u5-visual/table-${theme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.getByLabel('Tema', { exact: true }).selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  expect(
    ['0ms', '0s'].includes(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--panel'),
      ),
    ),
  ).toBe(true);
  await page.screenshot({ path: 'work/u5-visual/table-system-dark-reduced.png', fullPage: true });

  const labels = {
    en: ['Language', 'Actions'],
    fr: ['Langue', 'Actions'],
    pt: ['Idioma', 'Ações'],
    es: ['Idioma', 'Acciones'],
  } as const;
  for (const [locale, [language, actions]] of Object.entries(labels)) {
    await page.locator('.preferences select').first().selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByLabel(language, { exact: true })).toBeVisible();
    await page.locator('tbody .person').first().click();
    await expect(page.getByRole('dialog').getByLabel(actions, { exact: true })).toBeVisible();
    await page.screenshot({ path: `work/u5-visual/drawer-locale-${locale}.png`, fullPage: false });
    await page.keyboard.press('Escape');
    await expectNoHorizontalOverflow(page);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('U5 loading, empty, forbidden, not-found, throttled and unavailable states are announced', async ({
  page,
}) => {
  await login(page);
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('no-existe-u5');
  await expect(
    page.getByRole('heading', { name: 'Sin resultados con estos filtros' }),
  ).toBeVisible();
  const emptyState = page
    .getByRole('heading', { name: 'Sin resultados con estos filtros' })
    .locator('..');
  await expect(
    emptyState.getByRole('button', { name: 'Limpiar filtros', exact: true }),
  ).toBeVisible();
  await emptyState.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);

  await page.route('**/api/crm/opportunities?*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      data: { rows: unknown[]; total: number; stages: Array<{ count: number }> };
    };
    body.data.rows = [];
    body.data.total = 0;
    body.data.stages = body.data.stages.map((stage) => ({ ...stage, count: 0 }));
    await route.fulfill({ response, json: body });
  });
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('empty-transition');
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('');
  await expect(
    page.getByRole('heading', { name: 'Aún no tienes oportunidades activas' }),
  ).toBeVisible();
  await page.screenshot({ path: 'work/u5-visual/state-empty.png', fullPage: true });
  await page.unroute('**/api/crm/opportunities?*');
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);

  const cases: Array<[number, string]> = [
    [403, 'Acceso no disponible'],
    [404, 'No disponible o sin permiso.'],
    [429, 'Espera un momento antes de reintentar'],
    [503, 'No pudimos cargar esta vista'],
  ];
  for (const [status, title] of cases) {
    await page.route('**/api/crm/opportunities?*', (route) =>
      route.fulfill({ status, contentType: 'application/json', body: '{}' }),
    );
    await page.getByLabel('Buscar oportunidades', { exact: true }).fill(`state-${status}`);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(0);
    if ([403, 503].includes(status))
      await page.screenshot({ path: `work/u5-visual/state-${status}.png`, fullPage: true });
    await page.unroute('**/api/crm/opportunities?*');
    await page.getByLabel('Buscar oportunidades', { exact: true }).fill('');
    await expect(page.locator('tbody tr')).toHaveCount(20);
  }
  await page.route('**/api/crm/opportunities?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });
  const loadingResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/crm/opportunities?') && response.url().includes('loading-u5'),
  );
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('loading-u5');
  await expect(page.locator('.skeleton[aria-busy="true"]')).toBeVisible();
  await page.screenshot({ path: 'work/u5-visual/state-loading.png', fullPage: true });
  await loadingResponse;
  await page.unroute('**/api/crm/opportunities?*');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('U5 limited detail hides unauthorized contact fields without changing not-found privacy', async ({
  page,
}) => {
  await login(page);
  const detailPattern = /\/api\/crm\/opportunities\/[0-9a-f-]+$/;
  await page.route(detailPattern, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      data: {
        row: { canContact: boolean };
        contact: unknown;
        permissions: { editContact: boolean };
      };
    };
    body.data.row.canContact = false;
    body.data.contact = null;
    body.data.permissions.editContact = false;
    await route.fulfill({ response, json: body });
  });
  await page.locator('tbody .person').filter({ hasText: 'Persona sintética 003' }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('Contacto no disponible o no autorizado', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel('Acciones', { exact: true }).locator('option[value="edit_contact"]'),
  ).toHaveCount(0);
  await page.screenshot({ path: 'work/u5-visual/drawer-limited-data.png', fullPage: false });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
