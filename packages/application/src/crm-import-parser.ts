import { unzipSync } from 'fflate';
import { readSheet } from 'read-excel-file/universal';
import {
  crmImportRow,
  type CrmImportErrorCode,
  type CrmImportRow,
  type CrmImportRowError,
} from '@rpt/contracts';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_ROWS = 100;
const MAX_COLUMNS = 10;
const MAX_CELL_LENGTH = 1000;
const headers = [
  'display_name',
  'email',
  'phone',
  'opportunity_title',
  'source',
  'priority',
  'stage',
  'owner',
  'referrer_email',
  'referrer_phone',
] as const;
const allowedHeaders = new Set<string>(headers);
const requiredHeaders = ['display_name', 'opportunity_title'];
const fieldMap: Record<(typeof headers)[number], keyof CrmImportRow> = {
  display_name: 'displayName',
  email: 'email',
  phone: 'phone',
  opportunity_title: 'opportunityTitle',
  source: 'source',
  priority: 'priority',
  stage: 'stage',
  owner: 'owner',
  referrer_email: 'referrerEmail',
  referrer_phone: 'referrerPhone',
};

export interface ImportFile {
  name: string;
  bytes: Uint8Array;
}
export interface ParsedImportRow {
  row: number;
  value?: CrmImportRow;
  errors: CrmImportRowError[];
}
export interface ParsedImportFile {
  filename: string;
  format: 'csv' | 'xlsx';
  fileHash: string;
  rows: ParsedImportRow[];
}

export class CrmImportParseError extends Error {
  constructor(
    readonly code: CrmImportErrorCode,
    readonly reason: string,
  ) {
    super(reason);
  }
}

export async function parseCrmImportFile(file: ImportFile): Promise<ParsedImportFile> {
  if (file.bytes.length === 0 || file.bytes.length > MAX_FILE_BYTES)
    throw new CrmImportParseError('invalid_file', 'file_size');
  const filename = safeFilename(file.name);
  if (/\.(xlsm|xltm|xlam|xlsb|xls)$/i.test(filename))
    throw new CrmImportParseError('invalid_file', 'macro_or_legacy_excel_not_supported');
  const xlsx = file.bytes[0] === 0x50 && file.bytes[1] === 0x4b;
  const declaredFormat = /\.xlsx$/i.test(filename)
    ? 'xlsx'
    : /\.csv$/i.test(filename)
      ? 'csv'
      : null;
  if (!declaredFormat || (declaredFormat === 'xlsx') !== xlsx)
    throw new CrmImportParseError('invalid_file', 'format_mismatch');
  const matrix = xlsx ? await parseXlsx(file.bytes) : parseCsv(file.bytes);
  const rows = normalizeMatrix(matrix);
  return {
    filename,
    format: xlsx ? 'xlsx' : 'csv',
    fileHash: await sha256(file.bytes),
    rows,
  };
}

function safeFilename(value: string) {
  const base = value.split(/[\\/]/).at(-1)?.trim() || 'import';
  return base.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'import';
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseCsv(bytes: Uint8Array): unknown[][] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CrmImportParseError('invalid_file', 'csv_must_be_utf8');
  }
  text = text.replace(/^\uFEFF/, '');
  if (text.includes('\0')) throw new CrmImportParseError('invalid_file', 'nul_byte');
  const output: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') {
      if (cell.length > 0) throw new CrmImportParseError('invalid_file', 'invalid_csv_quote');
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      output.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (quoted) throw new CrmImportParseError('invalid_file', 'unterminated_csv_quote');
  row.push(cell.replace(/\r$/, ''));
  output.push(row);
  return output.filter((values) => values.some((value) => value.trim() !== ''));
}

async function parseXlsx(bytes: Uint8Array): Promise<unknown[][]> {
  let extracted: Record<string, Uint8Array>;
  let count = 0,
    expanded = 0;
  try {
    extracted = unzipSync(bytes, {
      filter: (file) => {
        count += 1;
        expanded += file.originalSize;
        const normalized = file.name.replaceAll('\\', '/');
        if (
          count > 200 ||
          file.originalSize > 4 * 1024 * 1024 ||
          expanded > 8 * 1024 * 1024 ||
          normalized.startsWith('/') ||
          normalized.includes('../') ||
          /(vbaProject\.bin|xl\/externalLinks\/|xl\/embeddings\/|xl\/activeX\/|customUI\/|connections\.xml)/i.test(
            normalized,
          )
        )
          throw new CrmImportParseError('invalid_file', 'unsafe_xlsx_package');
        return (
          normalized === '[Content_Types].xml' || /^xl\/worksheets\/[^/]+\.xml$/i.test(normalized)
        );
      },
    });
  } catch (error) {
    if (error instanceof CrmImportParseError) throw error;
    throw new CrmImportParseError('invalid_file', 'invalid_xlsx_package');
  }
  const decoder = new TextDecoder();
  const contentTypes = extracted['[Content_Types].xml'];
  if (!contentTypes) throw new CrmImportParseError('invalid_file', 'missing_xlsx_content_types');
  if (/macroEnabled|vbaProject|application\/vnd\.ms-excel/i.test(decoder.decode(contentTypes)))
    throw new CrmImportParseError('invalid_file', 'macro_enabled_xlsx');
  for (const [path, value] of Object.entries(extracted))
    if (path.startsWith('xl/worksheets/') && /<f(?:\s|>)/i.test(decoder.decode(value)))
      throw new CrmImportParseError('unsupported_value', 'xlsx_formulas_not_supported');
  try {
    return (await readSheet(bytes.slice().buffer)) as unknown[][];
  } catch {
    throw new CrmImportParseError('invalid_file', 'invalid_xlsx');
  }
}

function normalizeMatrix(matrix: unknown[][]): ParsedImportRow[] {
  if (matrix.length < 2)
    throw new CrmImportParseError('invalid_header', 'header_and_rows_required');
  if (matrix.length - 1 > MAX_ROWS)
    throw new CrmImportParseError('invalid_file', 'row_limit_exceeded');
  const rawHeader = matrix[0]!;
  if (rawHeader.length === 0 || rawHeader.length > MAX_COLUMNS)
    throw new CrmImportParseError('invalid_header', 'column_limit');
  const normalizedHeaders = rawHeader.map((cell) =>
    typeof cell === 'string' ? cell.trim().toLowerCase() : '',
  );
  if (
    normalizedHeaders.some((header) => !header || !allowedHeaders.has(header)) ||
    new Set(normalizedHeaders).size !== normalizedHeaders.length ||
    requiredHeaders.some((header) => !normalizedHeaders.includes(header))
  )
    throw new CrmImportParseError('invalid_header', 'unsupported_or_missing_header');
  return matrix.slice(1).map((cells, index) => normalizeRow(cells, normalizedHeaders, index + 2));
}

function normalizeRow(cells: unknown[], normalizedHeaders: string[], row: number): ParsedImportRow {
  const raw: Record<string, string> = {};
  const errors: CrmImportRowError[] = [];
  for (let column = 0; column < normalizedHeaders.length; column += 1) {
    const header = normalizedHeaders[column] as (typeof headers)[number];
    const cell = cells[column];
    if (cell !== undefined && cell !== null && typeof cell !== 'string') {
      errors.push({ row, code: 'unsupported_value', field: header, reason: 'text_required' });
      continue;
    }
    const value = (cell ?? '').trim();
    if (value.length > MAX_CELL_LENGTH) {
      errors.push({ row, code: 'invalid_row', field: header, reason: 'cell_too_long' });
      continue;
    }
    if (
      /^[=@]/.test(value) ||
      (!['phone', 'referrer_phone'].includes(header) && /^[+-]/.test(value))
    ) {
      errors.push({ row, code: 'unsupported_value', field: header, reason: 'formula_like_value' });
      continue;
    }
    raw[fieldMap[header]] = value;
  }
  if (errors.length > 0) return { row, errors };
  const parsed = crmImportRow.safeParse({
    displayName: raw.displayName,
    email: (raw.email ?? '').toLowerCase(),
    phone: raw.phone ?? '',
    opportunityTitle: raw.opportunityTitle,
    source: raw.source || 'import',
    priority: raw.priority || 'normal',
    stage: raw.stage || 'new',
    owner: raw.owner || 'self',
    referrerEmail: (raw.referrerEmail ?? '').toLowerCase(),
    referrerPhone: raw.referrerPhone ?? '',
  });
  if (!parsed.success)
    return {
      row,
      errors: parsed.error.issues.map((issue) => ({
        row,
        code:
          issue.message === 'identity_required'
            ? 'invalid_row'
            : issue.path[0] === 'owner'
              ? 'forbidden'
              : 'unsupported_value',
        field: String(issue.path[0] ?? ''),
        reason: issue.message,
      })),
    };
  return { row, value: parsed.data, errors: [] };
}
