import type { CommercialCalculationResult, QuoteCreate, QuoteLineSnapshot } from '@rpt/contracts';
import { canonicalCommercial } from '@rpt/domain';

/** Server dependency, never constructed from request input or runtime database data. */
export interface QuoteCalculationEnvelope {
  schemaVersion: 1;
  tenantId: string;
  actorId: string;
  quoteId: string;
  versionId: string;
  versionNumber: number;
  workspaceId: string;
  marketId: string;
  engineIdentity: 'E3B1/v1';
  input: QuoteCreate['calculation'];
  result: CommercialCalculationResult;
  lines: QuoteLineSnapshot[];
}
export interface QuoteCalculationAttestation {
  versionId: string;
  keyId: string;
  payload: string;
  tag: string;
}
export interface QuoteCalculationAttestor {
  attest(envelope: QuoteCalculationEnvelope): Promise<QuoteCalculationAttestation>;
}

/** Provision the matching tenant key through the privileged deployment path.
 * This authentication tag is NOT a replacement calculationHash or calculator.
 */
export function createQuoteCalculationAttestor(
  keyId: string,
  secretHex: string,
): QuoteCalculationAttestor {
  if (!/^[a-f0-9]{64,128}$/.test(secretHex) || secretHex.length % 2 !== 0)
    throw new RangeError('invalid quote attestation key');
  const secret = Uint8Array.from(secretHex.match(/../g)!, (byte) => parseInt(byte, 16));
  const key = crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return {
    async attest(envelope) {
      const payload = canonicalCommercial(envelope);
      const signature = await crypto.subtle.sign(
        'HMAC',
        await key,
        new TextEncoder().encode(payload),
      );
      return {
        versionId: envelope.versionId,
        keyId,
        payload,
        tag: Array.from(new Uint8Array(signature), (v) => v.toString(16).padStart(2, '0')).join(''),
      };
    },
  };
}
