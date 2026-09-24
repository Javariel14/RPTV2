import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FoundationService } from '@rpt/application';
import { FoundationError } from '@rpt/contracts';
import { PostgresDatabase } from '@rpt/persistence';
import { createApi } from '../../apps/api/src/app.js';
import { seedCrm } from '../helpers/crm-fixtures.js';
import { csvFile, unsafeMacroWorkbook, xlsxFile } from '../helpers/crm-import-files.js';
import { startPostgres } from '../helpers/postgres.js';

const header = [
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
];
const row = (
  name: string,
  email: string,
  title: string,
  options: Partial<{
    phone: string;
    source: string;
    priority: string;
    stage: string;
    owner: string;
    referrerEmail: string;
    referrerPhone: string;
  }> = {},
) => [
  name,
  email,
  options.phone ?? '',
  title,
  options.source ?? 'import',
  options.priority ?? 'normal',
  options.stage ?? 'new',
  options.owner ?? 'self',
  options.referrerEmail ?? '',
  options.referrerPhone ?? '',
];

await test('E1C2 commercial CSV/XLSX import', { timeout: 240_000 }, async (t) => {
  const cluster = await startPostgres();
  const root = await cluster.migrate();
  try {
    const a = await seedCrm(root, 'e1c2-a', 2);
    const b = await seedCrm(root, 'e1c2-b', 1);
    const database = new PostgresDatabase(cluster.runtimeConfig());
    const service = new FoundationService(database);
    const preview = (file: ReturnType<typeof csvFile> | ReturnType<typeof xlsxFile>) =>
      service.previewCrmImport(a.identities.owner, randomUUID(), file);
    const confirm = (
      file: ReturnType<typeof csvFile> | ReturnType<typeof xlsxFile>,
      hash: string,
      key = randomUUID(),
    ) => service.confirmCrmImport(a.identities.owner, randomUUID(), file, hash, key);
    const counts = async () =>
      (
        await root.query<{ people: number; opportunities: number; batches: number }>(
          `SELECT
            (SELECT count(*)::int FROM rpt.person WHERE tenant_id=$1) people,
            (SELECT count(*)::int FROM rpt.opportunity WHERE tenant_id=$1) opportunities,
            (SELECT count(*)::int FROM rpt.crm_import_batch WHERE tenant_id=$1) batches`,
          [a.tenant],
        )
      ).rows[0]!;

    await t.test(
      'preview is non-persistent and confirm is transactional and idempotent',
      async () => {
        const file = csvFile([
          header,
          row('Imported new person', 'new.import@example.invalid', 'CSV imported opportunity', {
            priority: 'high',
          }),
          row(
            'Existing display is not overwritten',
            'synthetic@example.invalid',
            'Linked opportunity',
          ),
          row('Invalid person', '', 'Rejected opportunity'),
        ]);
        const before = await counts();
        const prepared = await preview(file);
        assert.equal(prepared.accepted, true);
        assert.equal(prepared.validRows, 2);
        assert.equal(prepared.invalidRows, 1);
        assert.equal(prepared.newPersons, 1);
        assert.equal(prepared.linkedPersons, 1);
        assert.equal(prepared.errors[0]?.reason, 'identity_required');
        assert.equal(JSON.stringify(prepared).includes('new.import@example.invalid'), false);
        assert.deepEqual(await counts(), before);

        const key = randomUUID();
        const first = await confirm(file, prepared.previewHash, key);
        const replay = await confirm(file, prepared.previewHash, key);
        assert.deepEqual(replay, first);
        assert.equal(first.createdPersons, 1);
        assert.equal(first.createdOpportunities, 2);
        assert.equal(first.rejectedRows, 1);
        const after = await counts();
        assert.equal(after.people, before.people + 1);
        assert.equal(after.opportunities, before.opportunities + 2);
        assert.equal(after.batches, before.batches + 1);
        assert.equal(
          (
            await root.query<{ display_name: string }>(
              `SELECT p.display_name FROM rpt.person p JOIN rpt.person_pii pii
             ON (pii.tenant_id,pii.person_id)=(p.tenant_id,p.id)
             WHERE p.tenant_id=$1 AND pii.email='synthetic@example.invalid'`,
              [a.tenant],
            )
          ).rows[0]?.display_name,
          'Synthetic person',
        );
      },
    );

    await t.test(
      'multipart API separates preview and confirmation with bounded input',
      async () => {
        const api = createApi(service, { verify: async () => a.identities.owner });
        const file = csvFile([
          header,
          row('API person', 'api-import@example.invalid', 'API imported opportunity'),
        ]);
        const previewBody = new FormData();
        previewBody.set('file', new File([file.bytes], file.name, { type: 'text/csv' }));
        const previewResponse = await api.request('/v1/crm/imports/preview', {
          method: 'POST',
          headers: { Authorization: 'Bearer synthetic' },
          body: previewBody,
        });
        assert.equal(previewResponse.status, 200);
        const prepared = (await previewResponse.json()) as {
          data: { accepted: boolean; previewHash: string };
        };
        assert.equal(prepared.data.accepted, true);
        const confirmBody = new FormData();
        confirmBody.set('file', new File([file.bytes], file.name, { type: 'text/csv' }));
        confirmBody.set('previewHash', prepared.data.previewHash);
        const confirmResponse = await api.request('/v1/crm/imports/confirm', {
          method: 'POST',
          headers: { Authorization: 'Bearer synthetic', 'Idempotency-Key': randomUUID() },
          body: confirmBody,
        });
        assert.equal(confirmResponse.status, 201);
        const oversized = new FormData();
        oversized.set('file', new File([new Uint8Array(650 * 1024)], 'oversized.csv'));
        assert.equal(
          (
            await api.request('/v1/crm/imports/preview', {
              method: 'POST',
              headers: { Authorization: 'Bearer synthetic' },
              body: oversized,
            })
          ).status,
          413,
        );
      },
    );

    await t.test(
      'XLSX has the same logical result and referral reuses Person without grants',
      async () => {
        const grantsBefore = await root.query(
          'SELECT * FROM authz.access_grant WHERE tenant_id=$1 AND object_id=$2',
          [a.tenant, a.person],
        );
        const file = xlsxFile([
          header,
          row('Workbook person', 'workbook@example.invalid', 'Workbook opportunity', {
            source: 'referral',
            referrerEmail: 'synthetic@example.invalid',
          }),
        ]);
        const prepared = await preview(file);
        assert.equal(prepared.format, 'xlsx');
        const result = await confirm(file, prepared.previewHash);
        assert.equal(result.createdOpportunities, 1);
        assert.equal(
          (
            await root.query<{ referrer_person_id: string }>(
              "SELECT referrer_person_id FROM rpt.opportunity WHERE tenant_id=$1 AND title='Workbook opportunity'",
              [a.tenant],
            )
          ).rows[0]?.referrer_person_id,
          a.person,
        );
        const grantsAfter = await root.query(
          'SELECT * FROM authz.access_grant WHERE tenant_id=$1 AND object_id=$2',
          [a.tenant, a.person],
        );
        assert.equal(grantsAfter.rowCount, grantsBefore.rowCount);
      },
    );

    await t.test('exact identity is tenant-local and ambiguity never auto-merges', async () => {
      const crossTenantEmail = 'tenant-b-only@example.invalid';
      await root.query('UPDATE rpt.person_pii SET email=$3 WHERE tenant_id=$1 AND person_id=$2', [
        b.tenant,
        b.person,
        crossTenantEmail,
      ]);
      const crossFile = csvFile([
        header,
        row('Tenant A person', crossTenantEmail, 'Tenant-local opportunity'),
      ]);
      const crossPreview = await preview(crossFile);
      assert.equal(crossPreview.newPersons, 1);
      await confirm(crossFile, crossPreview.previewHash);
      const tenantAPerson = (
        await root.query<{ id: string }>(
          `SELECT p.id FROM rpt.person p JOIN rpt.person_pii pii
           ON (pii.tenant_id,pii.person_id)=(p.tenant_id,p.id)
           WHERE p.tenant_id=$1 AND pii.email=$2`,
          [a.tenant, crossTenantEmail],
        )
      ).rows[0]!.id;
      assert.notEqual(tenantAPerson, b.person);

      const duplicate = randomUUID();
      await root.query(
        "INSERT INTO rpt.person(tenant_id,id,workspace_id,owner_id,display_name,lifecycle) VALUES($1,$2,$3,$4,'Duplicate exact identity','prospect')",
        [a.tenant, duplicate, a.workspace, a.users.owner],
      );
      await root.query(
        'INSERT INTO rpt.person_pii(tenant_id,person_id,email,phone) VALUES($1,$2,$3,$4)',
        [a.tenant, duplicate, crossTenantEmail, null],
      );
      const ambiguous = await preview(
        csvFile([header, row('Ambiguous', crossTenantEmail, 'Must not import')]),
      );
      assert.equal(ambiguous.conflicts, 1);
      assert.equal(ambiguous.opportunitiesToCreate, 0);
      assert.equal(ambiguous.errors[0]?.code, 'ambiguous_identity');
    });

    await t.test('untrusted schema, owner, file and macro content fail closed', async () => {
      const unknown = await preview(
        csvFile([
          [...header, 'tenant', 'role', 'permission'],
          [
            ...row('Escalation', 'escalation@example.invalid', 'No write'),
            b.tenant,
            'owner',
            'admin',
          ],
        ]),
      );
      assert.equal(unknown.accepted, false);
      assert.equal(unknown.errors[0]?.code, 'invalid_header');
      const foreignOwner = await preview(
        csvFile([
          header,
          row('Foreign owner', 'owner@example.invalid', 'No write', { owner: b.users.owner }),
        ]),
      );
      assert.equal(foreignOwner.errors[0]?.code, 'forbidden');
      assert.equal(foreignOwner.opportunitiesToCreate, 0);
      const macro = await preview(unsafeMacroWorkbook());
      assert.equal(macro.accepted, false);
      assert.equal(macro.errors[0]?.code, 'invalid_file');
      const unsupported = await preview({ name: 'legacy.xls', bytes: new Uint8Array([1, 2, 3]) });
      assert.equal(unsupported.accepted, false);
      assert.equal(unsupported.errors[0]?.reason, 'macro_or_legacy_excel_not_supported');
    });

    await t.test(
      'authorization, revocation and preview-state conflict are enforced server-side',
      async () => {
        const file = csvFile([
          header,
          row('Concurrent person', 'concurrent@example.invalid', 'Concurrent opportunity'),
        ]);
        for (const identity of [a.identities.ancestor, a.identities.outsider])
          await assert.rejects(
            service.previewCrmImport(identity, randomUUID(), file),
            (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
          );
        const prepared = await preview(file);
        const person = randomUUID();
        await root.query(
          "INSERT INTO rpt.person(tenant_id,id,workspace_id,owner_id,display_name,lifecycle) VALUES($1,$2,$3,$4,'Concurrent existing','prospect')",
          [a.tenant, person, a.workspace, a.users.owner],
        );
        await root.query(
          "INSERT INTO rpt.person_pii(tenant_id,person_id,email) VALUES($1,$2,'concurrent@example.invalid')",
          [a.tenant, person],
        );
        await assert.rejects(
          confirm(file, prepared.previewHash),
          (error) => error instanceof FoundationError && error.code === 'CONFLICT',
        );
        await root.query(
          "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='owner' AND object_type='opportunity' AND verb='create' AND field_class='CONFIDENTIAL'",
          [a.tenant],
        );
        await assert.rejects(
          preview(file),
          (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
        );
        await root.query(
          "INSERT INTO authz.role_capability VALUES($1,'owner','opportunity','create','CONFIDENTIAL',false,1)",
          [a.tenant],
        );
      },
    );

    await t.test(
      'database error rolls the whole batch back; audit and provenance remain append-only',
      async () => {
        await root.query(`CREATE FUNCTION rpt.e1c2_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.title='E1C2 forced failure' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END $$`);
        await root.query(`CREATE TRIGGER e1c2_test_failure BEFORE INSERT ON rpt.opportunity
        FOR EACH ROW EXECUTE FUNCTION rpt.e1c2_test_failure()`);
        const file = csvFile([
          header,
          row('Rollback one', 'rollback-one@example.invalid', 'Would otherwise persist'),
          row('Rollback two', 'rollback-two@example.invalid', 'E1C2 forced failure'),
        ]);
        const prepared = await preview(file);
        const before = await counts();
        await assert.rejects(confirm(file, prepared.previewHash));
        assert.deepEqual(await counts(), before);
        assert.equal(
          (
            await root.query<{ count: number }>(
              "SELECT count(*)::int count FROM rpt.person_pii WHERE tenant_id=$1 AND email LIKE 'rollback-%'",
              [a.tenant],
            )
          ).rows[0]!.count,
          0,
        );
        await root.query('DROP TRIGGER e1c2_test_failure ON rpt.opportunity');
        await root.query('DROP FUNCTION rpt.e1c2_test_failure()');

        const provenance = await root.query<{ count: number }>(
          `SELECT count(*)::int count FROM rpt.crm_import_item i
         JOIN rpt.crm_import_batch b ON (b.tenant_id,b.id)=(i.tenant_id,i.batch_id)
         WHERE i.tenant_id=$1 AND b.source_format IN ('csv','xlsx') AND b.file_hash ~ '^[0-9a-f]{64}$'`,
          [a.tenant],
        );
        assert.ok(provenance.rows[0]!.count >= 3);
        const audit = await root.query<{ object_type: string; action: string }>(
          `SELECT object_type,action FROM rpt.audit_event WHERE tenant_id=$1
         AND (object_type IN ('crm_import_batch','crm_import_item') OR action='crm.import.confirm')`,
          [a.tenant],
        );
        assert.ok(audit.rows.some(({ object_type }) => object_type === 'crm_import_batch'));
        assert.ok(audit.rows.some(({ object_type }) => object_type === 'crm_import_item'));
        assert.ok(audit.rows.some(({ action }) => action === 'crm.import.confirm'));
        await assert.rejects(
          database.request(a.identities.owner, randomUUID(), (client) =>
            client.query('DELETE FROM rpt.crm_import_batch WHERE tenant_id=$1', [a.tenant]),
          ),
        );
      },
    );
  } finally {
    await root.end();
    await cluster.stop();
  }
});
