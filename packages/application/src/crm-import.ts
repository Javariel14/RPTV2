import type { Client } from 'pg';
import {
  FoundationError,
  type CrmImportPreview,
  type CrmImportPreviewRow,
  type CrmImportRow,
  type CrmImportRowError,
  type CrmImportSummary,
} from '@rpt/contracts';
import type { AuthContext } from '@rpt/persistence';
import { crmContext } from './crm.js';
import {
  CrmImportParseError,
  parseCrmImportFile,
  type ImportFile,
  type ParsedImportFile,
} from './crm-import-parser.js';

interface Resolution {
  status: 'none' | 'match' | 'ambiguous';
  personId?: string;
}
interface AnalyzedRow {
  row: number;
  value?: CrmImportRow;
  status: 'valid' | 'invalid' | 'conflict';
  errors: CrmImportRowError[];
  personId?: string;
  newPersonKey?: string;
  referrerPersonId?: string;
}
interface Analysis {
  parsed: ParsedImportFile;
  rows: AnalyzedRow[];
  preview: CrmImportPreview;
}

export async function previewCrmImport(
  client: Client,
  file: ImportFile,
): Promise<CrmImportPreview> {
  const session = await requireImport(client);
  try {
    return (await analyze(client, session.workspaceId!, await parseCrmImportFile(file))).preview;
  } catch (error) {
    if (error instanceof CrmImportParseError) return rejectedPreview(file.name, error);
    throw error;
  }
}

export async function confirmCrmImport(
  client: Client,
  context: AuthContext,
  file: ImportFile,
  previewHash: string,
  key: string,
): Promise<CrmImportSummary> {
  const session = await requireImport(client);
  let parsed: ParsedImportFile;
  try {
    parsed = await parseCrmImportFile(file);
  } catch {
    throw new FoundationError('INVALID_REQUEST');
  }
  const requestHash = await hashValue({ fileHash: parsed.fileHash, previewHash });
  const previous = (
    await client.query<{ value: CrmImportSummary | null }>(
      'SELECT authz.crm_receipt($1,$2) AS value',
      [key, requestHash],
    )
  ).rows[0]?.value;
  if (previous) return previous;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1||'/crm-import',0))", [
    context.tenantId,
  ]);
  const analysis = await analyze(client, session.workspaceId!, parsed);
  if (!analysis.preview.accepted || analysis.preview.previewHash !== previewHash)
    throw new FoundationError('CONFLICT');

  const batchId = crypto.randomUUID();
  const createdPeople = new Map<string, string>();
  const validRows = analysis.rows.filter((row) => row.status === 'valid' && row.value);
  await client.query(
    `INSERT INTO rpt.crm_import_batch(
      tenant_id,id,actor_id,workspace_id,source_filename,source_format,file_hash,status,
      total_rows,created_persons,linked_persons,created_opportunities,rejected_rows,
      conflict_rows,idempotency_key,request_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      context.tenantId,
      batchId,
      context.actorId,
      session.workspaceId,
      parsed.filename,
      parsed.format,
      parsed.fileHash,
      analysis.preview.totalRows,
      analysis.preview.newPersons,
      analysis.preview.linkedPersons,
      validRows.length,
      analysis.preview.invalidRows,
      analysis.preview.conflicts,
      key,
      context.requestId,
    ],
  );

  for (const analyzed of validRows) {
    const row = analyzed.value!;
    let personId = analyzed.personId;
    let resolution: 'created' | 'linked' = 'linked';
    if (!personId) {
      const group = analyzed.newPersonKey!;
      personId = createdPeople.get(group);
      if (!personId) {
        personId = crypto.randomUUID();
        await client.query(
          `INSERT INTO rpt.person(tenant_id,id,workspace_id,owner_id,display_name,lifecycle)
           VALUES($1,$2,$3,$4,$5,'prospect')`,
          [context.tenantId, personId, session.workspaceId, context.actorId, row.displayName],
        );
        await client.query(
          'INSERT INTO rpt.person_pii(tenant_id,person_id,email,phone) VALUES($1,$2,$3,$4)',
          [context.tenantId, personId, row.email || null, row.phone || null],
        );
        createdPeople.set(group, personId);
        resolution = 'created';
      }
    }
    const opportunityId = crypto.randomUUID();
    await client.query(
      `INSERT INTO rpt.opportunity(
        tenant_id,id,person_id,workspace_id,owner_id,title,source,priority,referrer_person_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        context.tenantId,
        opportunityId,
        personId,
        session.workspaceId,
        context.actorId,
        row.opportunityTitle,
        row.source,
        row.priority,
        analyzed.referrerPersonId ?? null,
      ],
    );
    await client.query(
      `INSERT INTO rpt.crm_import_item(
        tenant_id,id,batch_id,row_number,person_id,opportunity_id,person_resolution)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,
        crypto.randomUUID(),
        batchId,
        analyzed.row,
        personId,
        opportunityId,
        resolution,
      ],
    );
  }
  const summary: CrmImportSummary = {
    batchId,
    status: 'completed',
    totalRows: analysis.preview.totalRows,
    createdPersons: createdPeople.size,
    linkedPersons: analysis.preview.linkedPersons,
    createdOpportunities: validRows.length,
    rejectedRows: analysis.preview.invalidRows,
    conflictRows: analysis.preview.conflicts,
  };
  await client.query('SELECT authz.crm_finish($1,$2)', [key, JSON.stringify(summary)]);
  return summary;
}

async function requireImport(client: Client) {
  const session = await crmContext(client);
  if (!session.canCreate || !session.workspaceId) throw new FoundationError('FORBIDDEN');
  const ready = (
    await client.query<{ allowed: boolean }>('SELECT authz.crm_import_ready($1) allowed', [
      session.workspaceId,
    ])
  ).rows[0]?.allowed;
  if (!ready) throw new FoundationError('FORBIDDEN');
  return session;
}

async function analyze(
  client: Client,
  workspaceId: string,
  parsed: ParsedImportFile,
): Promise<Analysis> {
  const rows: AnalyzedRow[] = [];
  const newIdentitySignatures = new Map<string, string>();
  const opportunityKeys = new Set<string>();
  for (const source of parsed.rows) {
    if (!source.value) {
      rows.push({ row: source.row, status: 'invalid', errors: source.errors });
      continue;
    }
    const value = source.value;
    const resolution = await resolve(client, workspaceId, value.email, value.phone);
    if (resolution.status === 'ambiguous') {
      rows.push({
        row: source.row,
        value,
        status: 'conflict',
        errors: [error(source.row, 'ambiguous_identity', 'identity', 'exact_identity_conflict')],
      });
      continue;
    }
    let newPersonKey: string | undefined;
    if (resolution.status === 'none') {
      const signature = `${value.email}\u0000${value.phone}`;
      const identifiers = [
        value.email && `email:${value.email}`,
        value.phone && `phone:${value.phone}`,
      ].filter(Boolean) as string[];
      const incompatible = identifiers.some(
        (identifier) =>
          newIdentitySignatures.has(identifier) &&
          newIdentitySignatures.get(identifier) !== signature,
      );
      if (incompatible) {
        rows.push({
          row: source.row,
          value,
          status: 'conflict',
          errors: [error(source.row, 'duplicate_identity', 'identity', 'inconsistent_identity')],
        });
        continue;
      }
      for (const identifier of identifiers) newIdentitySignatures.set(identifier, signature);
      newPersonKey = signature;
    }
    let referrerPersonId: string | undefined;
    if (value.referrerEmail || value.referrerPhone) {
      const referrer = await resolve(client, workspaceId, value.referrerEmail, value.referrerPhone);
      if (referrer.status !== 'match') {
        rows.push({
          row: source.row,
          value,
          status: referrer.status === 'ambiguous' ? 'conflict' : 'invalid',
          errors: [
            error(
              source.row,
              referrer.status === 'ambiguous' ? 'ambiguous_identity' : 'invalid_row',
              'referrer',
              referrer.status === 'ambiguous' ? 'referrer_conflict' : 'referrer_not_found',
            ),
          ],
        });
        continue;
      }
      referrerPersonId = referrer.personId;
    }
    const opportunityKey = `${resolution.personId ?? newPersonKey}\u0000${value.opportunityTitle.toLowerCase()}`;
    if (opportunityKeys.has(opportunityKey)) {
      rows.push({
        row: source.row,
        value,
        status: 'conflict',
        errors: [
          error(source.row, 'duplicate_identity', 'opportunityTitle', 'duplicate_batch_row'),
        ],
      });
      continue;
    }
    opportunityKeys.add(opportunityKey);
    rows.push({
      row: source.row,
      value,
      status: 'valid',
      errors: [],
      ...(resolution.personId ? { personId: resolution.personId } : {}),
      ...(newPersonKey ? { newPersonKey } : {}),
      ...(referrerPersonId ? { referrerPersonId } : {}),
    });
  }
  const publicRows: CrmImportPreviewRow[] = rows.map((row) => ({
    row: row.row,
    displayName: row.value?.displayName ?? '',
    opportunityTitle: row.value?.opportunityTitle ?? '',
    status: row.status,
    personResolution: row.status !== 'valid' ? null : row.personId ? 'existing' : ('new' as const),
    errors: row.errors,
  }));
  const errors = rows.flatMap((row) => row.errors);
  const valid = rows.filter((row) => row.status === 'valid');
  const newPeople = new Set(valid.map((row) => row.newPersonKey).filter(Boolean));
  const linkedPeople = new Set(valid.map((row) => row.personId).filter(Boolean));
  const previewHash = await hashValue({
    fileHash: parsed.fileHash,
    rows: rows.map((row) => ({
      row: row.row,
      status: row.status,
      personId: row.personId,
      newPersonKey: row.newPersonKey,
      referrerPersonId: row.referrerPersonId,
      errors: row.errors.map(({ code, field, reason }) => ({ code, field, reason })),
    })),
  });
  return {
    parsed,
    rows,
    preview: {
      accepted: true,
      format: parsed.format,
      filename: parsed.filename,
      previewHash,
      totalRows: rows.length,
      validRows: valid.length,
      invalidRows: rows.filter((row) => row.status === 'invalid').length,
      newPersons: newPeople.size,
      linkedPersons: linkedPeople.size,
      conflicts: rows.filter((row) => row.status === 'conflict').length,
      opportunitiesToCreate: valid.length,
      rows: publicRows,
      errors,
    },
  };
}

async function resolve(client: Client, workspaceId: string, email: string, phone: string) {
  return (
    await client.query<{ value: Resolution }>(
      'SELECT authz.crm_import_resolve_person($1,$2,$3) value',
      [workspaceId, email, phone],
    )
  ).rows[0]!.value;
}

function error(
  row: number,
  code: CrmImportRowError['code'],
  field: string,
  reason: string,
): CrmImportRowError {
  return { row, code, field, reason };
}

function rejectedPreview(filename: string, cause: CrmImportParseError): CrmImportPreview {
  const safeName =
    filename
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/[^\p{L}\p{N}._ -]/gu, '_')
      .slice(0, 120) || 'import';
  const fileError = error(0, cause.code, 'file', cause.reason);
  return {
    accepted: false,
    format: 'unknown',
    filename: safeName,
    previewHash: '',
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    newPersons: 0,
    linkedPersons: 0,
    conflicts: 0,
    opportunitiesToCreate: 0,
    rows: [],
    errors: [fileError],
  };
}

async function hashValue(value: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
