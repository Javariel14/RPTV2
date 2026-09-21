import { unzipSync, zipSync } from 'fflate';

const encoder = new TextEncoder();

export function csvFile(rows: string[][], name = 'commercial-import.csv') {
  const csv = rows
    .map((row) =>
      row
        .map((value) => (/[,"\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
        .join(','),
    )
    .join('\n');
  return { name, bytes: encoder.encode(csv) };
}

export function xlsxFile(rows: string[][], name = 'commercial-import.xlsx') {
  const sheet = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map(
            (value, columnIndex) =>
              `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`,
          )
          .join('')}</row>`,
    )
    .join('');
  return {
    name,
    bytes: zipSync({
      '[Content_Types].xml': encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
      '_rels/.rels': encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
      'xl/workbook.xml': encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Import" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
      ),
    }),
  };
}

export function unsafeMacroWorkbook() {
  const file = xlsxFile([
    ['display_name', 'email', 'opportunity_title'],
    ['Synthetic', 'synthetic@example.invalid', 'Opportunity'],
  ]);
  return {
    name: 'unsafe.xlsx',
    bytes: zipSync({
      '[Content_Types].xml': encoder.encode(
        '<Types><Override ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
      ),
      'xl/vbaProject.bin': encoder.encode('not executable'),
      'xl/worksheets/sheet1.xml': file.bytes,
    }),
  };
}

export function xlsxFormulaFile() {
  const base = xlsxFile([
    ['display_name', 'email', 'opportunity_title'],
    ['Synthetic', 'synthetic@example.invalid', 'Opportunity'],
  ]);
  const parts = unzipSync(base.bytes);
  parts['xl/worksheets/sheet1.xml'] = encoder.encode(
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>SUM(A2:A3)</f><v>1</v></c></row></sheetData></worksheet>',
  );
  return { name: 'formula.xlsx', bytes: zipSync(parts) };
}

function columnName(index: number) {
  return String.fromCharCode(65 + index);
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
