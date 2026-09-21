import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CrmImportParseError,
  parseCrmImportFile,
} from '../../packages/application/src/crm-import-parser.js';
import {
  csvFile,
  unsafeMacroWorkbook,
  xlsxFile,
  xlsxFormulaFile,
} from '../helpers/crm-import-files.js';

const header = ['display_name', 'email', 'phone', 'opportunity_title', 'source', 'priority'];
const row = [
  'Synthetic Import',
  'import@example.invalid',
  '+593000000',
  'Imported sale',
  'import',
  'high',
];

await test('E1C2 parses CSV and XLSX into the same allow-listed contract', async () => {
  const csv = await parseCrmImportFile(csvFile([header, row]));
  const xlsx = await parseCrmImportFile(xlsxFile([header, row]));
  assert.equal(csv.format, 'csv');
  assert.equal(xlsx.format, 'xlsx');
  assert.deepEqual(csv.rows, xlsx.rows);
  assert.equal(csv.rows[0]?.value?.owner, 'self');
  assert.equal(csv.rows[0]?.value?.stage, 'new');
});

await test('E1C2 rejects unknown columns, formulas, unsupported files and macro workbooks', async () => {
  for (const [file, code, reason] of [
    [
      csvFile([
        [...header, 'tenant'],
        [...row, 'another'],
      ]),
      'invalid_header',
      'unsupported_or_missing_header',
    ],
    [{ name: 'empty.csv', bytes: new Uint8Array() }, 'invalid_file', 'file_size'],
    [csvFile([header, row], 'disguised.exe'), 'invalid_file', 'format_mismatch'],
    [csvFile([header, row], 'disguised.xlsx'), 'invalid_file', 'format_mismatch'],
    [unsafeMacroWorkbook(), 'invalid_file', 'unsafe_xlsx_package'],
    [xlsxFormulaFile(), 'unsupported_value', 'xlsx_formulas_not_supported'],
  ] as const) {
    await assert.rejects(
      parseCrmImportFile(file),
      (error) =>
        error instanceof CrmImportParseError && error.code === code && error.reason === reason,
    );
  }
  const formula = await parseCrmImportFile(
    csvFile([header, [...row.slice(0, 3), '=cmd()', ...row.slice(4)]]),
  );
  assert.equal(formula.rows[0]?.errors[0]?.code, 'unsupported_value');
  assert.equal(formula.rows[0]?.errors[0]?.reason, 'formula_like_value');
});

await test('E1C2 reports invalid rows without interpreting input', async () => {
  const parsed = await parseCrmImportFile(
    csvFile([
      header,
      ['Missing identity', '', '', 'Allowed title', 'import', 'normal'],
      ['Formula', 'formula@example.invalid', '', '+SUM(A1:A2)', 'import', 'normal'],
    ]),
  );
  assert.equal(parsed.rows[0]?.errors[0]?.reason, 'identity_required');
  assert.equal(parsed.rows[1]?.errors[0]?.reason, 'formula_like_value');
});
