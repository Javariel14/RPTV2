import { mkdir } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { xlsxFile } from '../helpers/crm-import-files.js';

test('E1 closure Commercial light ES Drawer retains its accessible explanation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/crm/commercial');
  await page.getByLabel('Código de sesión local').fill('u3-synthetic-test-session');
  await page.getByRole('button', { name: 'Iniciar sesión local', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.getByLabel('Tema', { exact: true }).selectOption('light');
  const trigger = page.locator('tbody .person').first();
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.crm-intelligence')).toContainText('Cálculo RPT');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await mkdir('work/e1-closure-visual', { recursive: true });
  await page.screenshot({ path: 'work/e1-closure-visual/commercial-light-es-drawer.png' });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('E1 import preview and result are explicit, accessible and persistent', async ({ page }) => {
  await page.goto('/crm/commercial');
  await page.getByLabel('Código de sesión local').fill('u3-synthetic-test-session');
  await page.getByRole('button', { name: 'Iniciar sesión local', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.getByLabel('Tema', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Importar', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Archivo').setInputFiles({
    name: 'e1-closure.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'display_name,email,phone,opportunity_title,source,priority',
        'E1 Closure Person,e1-closure@example.invalid,,E1 Closure Opportunity,import,normal',
        'Invalid Row,,,Missing identity,import,normal',
      ].join('\n'),
      'utf8',
    ),
  });
  const previewResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/crm/imports/preview'),
  );
  await dialog.getByRole('button', { name: 'Generar vista previa', exact: true }).click();
  const response = await previewResponse;
  expect(response.status()).toBe(200);
  await expect(dialog.getByRole('heading', { name: 'Resumen de vista previa' })).toBeVisible();
  await expect(dialog.getByText('Se requiere email o teléfono', { exact: false })).toBeVisible();
  await mkdir('work/e1-closure-visual', { recursive: true });
  await page.screenshot({
    path: 'work/e1-closure-visual/commercial-import-preview-light-es.png',
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await dialog.getByRole('button', { name: 'Confirmar importación', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Resultado' })).toBeVisible();
  await expect(dialog.getByText('Importación completada', { exact: true })).toBeVisible();
  await expect(page.getByText('Importación completada y lista actualizada.')).toBeVisible();
  await page.screenshot({ path: 'work/e1-closure-visual/commercial-import-result-light-es.png' });
  await page.keyboard.press('Escape');
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('E1 Closure Person');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.reload();
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('E1 Closure Person');
  await expect(page.locator('tbody tr')).toHaveCount(1);
});

test('E1 XLSX bytes survive the browser bridge and persist through confirmation', async ({
  page,
}) => {
  await page.goto('/crm/commercial');
  await page.getByLabel('Código de sesión local').fill('u3-synthetic-test-session');
  await page.getByRole('button', { name: 'Iniciar sesión local', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  const file = xlsxFile([
    ['display_name', 'email', 'opportunity_title', 'source'],
    ['E1 XLSX Ángela', 'e1-xlsx@example.invalid', 'E1 XLSX Opportunity', 'import'],
  ]);
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Archivo').setInputFiles({
    name: file.name,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(file.bytes),
  });
  await dialog.getByRole('button', { name: 'Generar vista previa', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Resumen de vista previa' })).toBeVisible();
  await expect(
    dialog.locator('dl > div').filter({ hasText: 'Personas enlazadas' }).locator('dd'),
  ).toHaveText('0');
  await expect(
    dialog.locator('dl > div').filter({ hasText: 'Personas nuevas' }).locator('dd'),
  ).toHaveText('1');
  await dialog.getByRole('button', { name: 'Confirmar importación', exact: true }).click();
  await expect(dialog.getByText('Importación completada', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByLabel('Buscar oportunidades', { exact: true }).fill('E1 XLSX Ángela');
  await expect(page.locator('tbody tr')).toHaveCount(1);
});
