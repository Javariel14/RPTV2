import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('reference functional contracts and inaccessible states', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CRM Comercial' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Buscar oportunidades' }).fill('Lucía');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'Guardar vista', exact: true }).click();
  await page.getByLabel('Nombre de la vista').fill('Mi filtro ficticio');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await page.getByRole('textbox', { name: 'Buscar oportunidades' }).fill('');
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.getByRole('button', { name: 'Mi filtro ficticio' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.locator('.person').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const before = await page.locator('dd').last().textContent();
  await page.getByRole('button', { name: 'Registrar actividad de prueba' }).click();
  await expect(page.locator('dd').last()).toHaveText(String(Number(before) + 1));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.person').first()).toBeFocused();
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  await expect(page.locator('.kanban > section')).toHaveCount(4);
  await page.getByRole('button', { name: 'Componentes', exact: true }).first().click();
  await page.getByLabel('Cantidad de ejemplos').selectOption('1000');
  await page.getByRole('button', { name: 'Referencia CRM', exact: true }).last().click();
  await page.getByRole('textbox', { name: 'Buscar oportunidades' }).fill('');
  await page.getByRole('button', { name: 'Tabla', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await expect(page.locator('.pagination')).toContainText('21–40');
  for (const state of [
    'permission',
    '401',
    '404',
    '429',
    '500',
    '502',
    '503',
    '504',
    'empty',
    'loading',
    'offline',
    'degraded',
    'ready',
  ]) {
    await page.getByRole('button', { name: 'Componentes', exact: true }).first().click();
    await page.getByLabel('Estado de prueba').selectOption(state);
    await page.getByRole('button', { name: 'Referencia CRM', exact: true }).last().click();
    if (!['offline', 'degraded', 'ready'].includes(state))
      await expect(page.locator('tbody tr')).toHaveCount(0);
    if (state === 'permission')
      await expect(page.getByRole('heading', { name: 'Acceso no disponible' })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
test('canonical widths, themes, language, drawer, accessibility', async ({ page }, info) => {
  await page.goto('/');
  for (const theme of ['light', 'dark']) {
    await page.getByRole('combobox', { name: 'Tema' }).selectOption(theme);
    for (const width of [320, 390, 768, 1024, 1280, 1440, 1728]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(page.getByRole('heading', { name: 'CRM Comercial' })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
      ).toEqual([]);
      await page.screenshot({ path: info.outputPath(`crm-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.mobile-list article button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect((await page.getByRole('dialog').boundingBox())?.width).toBe(390);
  await page.screenshot({ path: info.outputPath('drawer-mobile-dark.png') });
  await page.keyboard.press('Escape');
  for (const locale of ['en', 'fr', 'pt', 'es']) {
    await page.locator('.preferences select').first().selectOption(locale);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`crm-locale-${locale}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.person').first().click();
  expect((await page.getByRole('dialog').boundingBox())?.width).toBe(460);
  await page.screenshot({ path: info.outputPath('drawer-desktop-dark.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Contraer navegación' }).click();
  expect((await page.locator('.sidebar').boundingBox())?.width).toBe(72);
});
test('system theme follows OS, SSR preference persists, reduced motion and 200% equivalent reflow', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Tema' }).selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .not.toBe(dark);
  await page.getByRole('combobox', { name: 'Tema' }).selectOption('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Browser zoom reduces the layout viewport; CSS zoom does NOT adjust media
  // queries, so CSS style.zoom would exercise a different, unsupported operation.
  await page.setViewportSize({ width: 640, height: 500 });
  await expect(page.getByRole('heading', { name: 'CRM Comercial' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('crm-200-equivalent-reflow.png'), fullPage: true });
  const duration = await page
    .locator('.button')
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(parseFloat(duration)).toBeLessThanOrEqual(0.01);
});
