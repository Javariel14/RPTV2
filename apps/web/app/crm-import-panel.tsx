'use client';
import { useRef, useState } from 'react';
import type { CrmImportPreview, CrmImportSummary } from '@rpt/contracts/crm';
import { Button, Panel } from '@rpt/ui';
import { crmRequest } from './use-crm-data';

export function CrmImportPanel({
  label,
  onClose,
  onImported,
}: {
  label: (key: string) => string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<CrmImportPreview>();
  const [summary, setSummary] = useState<CrmImportSummary>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = useRef<{ hash: string; key: string } | null>(null);

  async function requestPreview() {
    if (!file || busy) return;
    setBusy(true);
    setFailed(false);
    setSummary(undefined);
    attempt.current = null;
    try {
      const body = new FormData();
      body.set('file', file);
      setPreview(await crmRequest<CrmImportPreview>('imports/preview', { method: 'POST', body }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!file || !preview?.accepted || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      if (attempt.current?.hash !== preview.previewHash)
        attempt.current = { hash: preview.previewHash, key: crypto.randomUUID() };
      const idempotencyKey = attempt.current?.key;
      if (!idempotencyKey) throw new Error('missing import attempt');
      const body = new FormData();
      body.set('file', file);
      body.set('previewHash', preview.previewHash);
      const result = await crmRequest<CrmImportSummary>('imports/confirm', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body,
      });
      setSummary(result);
      onImported();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={label('importTitle')} kind="dialog" closeLabel={label('close')} onClose={onClose}>
      <div className="crm-import" aria-busy={busy}>
        <p>{label('fileHelp')}</p>
        <label>
          {label('chooseFile')}
          <input
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => {
              setFile(event.target.files?.[0]);
              setPreview(undefined);
              setSummary(undefined);
              setFailed(false);
              attempt.current = null;
            }}
          />
        </label>
        <Button variant="primary" disabled={!file || busy} onClick={() => void requestPreview()}>
          {busy ? label('loading') : label('previewImport')}
        </Button>
        {failed && (
          <p role="alert" className="error-message">
            {label('importError')}
          </p>
        )}
        {preview && (
          <section aria-live="polite">
            <h3>{label('previewSummary')}</h3>
            <dl className="import-summary">
              {(
                [
                  'totalRows',
                  'validRows',
                  'invalidRows',
                  'newPersons',
                  'linkedPersons',
                  'conflicts',
                  'opportunitiesToCreate',
                ] as const
              ).map((key) => (
                <div key={key}>
                  <dt>{label(key)}</dt>
                  <dd>{preview[key]}</dd>
                </div>
              ))}
            </dl>
            {preview.errors.length > 0 && (
              <div className="import-errors" role="alert">
                <h3>{label('errors')}</h3>
                <ul>
                  {preview.errors.map((error, index) => (
                    <li key={`${error.row}/${error.field}/${index}`}>
                      {error.row > 0 && `${label('row')} ${error.row} · `}
                      {label(error.code)} · {label(error.field ?? 'file')} · {label(error.reason)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.accepted && preview.validRows > 0 && !summary && (
              <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
                {busy ? label('loading') : label('confirmImport')}
              </Button>
            )}
          </section>
        )}
        {summary && (
          <section role="status" aria-live="polite">
            <h3>{label('result')}</h3>
            <p>{label('completed')}</p>
            <dl className="import-summary">
              {(
                [
                  'createdPersons',
                  'linkedPersons',
                  'createdOpportunities',
                  'rejectedRows',
                  'conflictRows',
                ] as const
              ).map((key) => (
                <div key={key}>
                  <dt>{label(key)}</dt>
                  <dd>{summary[key]}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </Panel>
  );
}
