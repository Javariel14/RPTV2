import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('E1C3 explainable CRM intelligence is localized, accessible and responsive', async ({
  page,
}) => {
  await page.goto('/crm/commercial');
  await page.getByLabel('Código de sesión local').fill('u3-synthetic-test-session');
  await page.getByRole('button', { name: 'Iniciar sesión local', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await expect(page.locator('tbody .intelligence-compact').first()).toContainText('/100');

  const healthLabels = {
    es: 'Salud de la relación',
    en: 'Relationship health',
    fr: 'Santé de la relation',
    pt: 'Saúde do relacionamento',
  };
  for (const [locale, healthLabel] of Object.entries(healthLabels)) {
    await page.locator('.preferences select').first().selectOption(locale);
    await page.locator('tbody .person').first().click();
    const drawer = page.getByRole('dialog');
    const intelligence = drawer.locator('.crm-intelligence');
    await expect(intelligence).toHaveAttribute('aria-label', healthLabel);
    await expect(intelligence).toContainText('/100');
    await expect(intelligence).not.toContainText(
      /recent_activity|missing_next_action|stage_next_step/,
    );
    await drawer.locator('header button').click();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.preferences select').first().selectOption('es');
  await page.locator('.mobile-list article button').first().click();
  await expect(page.locator('.crm-intelligence')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
