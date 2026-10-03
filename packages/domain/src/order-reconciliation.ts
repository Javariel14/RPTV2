export type ReconciliationStatus =
  | 'unmatched'
  | 'matched'
  | 'conflict'
  | 'pending_review'
  | 'resolved_official_wins'
  | 'resolved_local_verified'
  | 'ignored_with_reason';

function timestampMicros(value: string): bigint | null {
  const milliseconds = Date.parse(value);
  const fraction = value.match(/:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? '';
  if (!Number.isFinite(milliseconds) || fraction.length > 6) return null;
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3, 6));
}

/** Equal timestamps with distinct hashes have no provider sequence authority. */
export function classifyExternalOrderEvent(
  current: { effectiveAt: string; observedAt: string; hash: string } | null,
  incoming: { effectiveAt: string; observedAt: string; hash: string },
): 'unmatched' | 'duplicate' | 'stale' | 'conflict' | 'newer' {
  if (!current) return 'unmatched';
  const currentEffective = timestampMicros(current.effectiveAt);
  const currentObserved = timestampMicros(current.observedAt);
  const incomingEffective = timestampMicros(incoming.effectiveAt);
  const incomingObserved = timestampMicros(incoming.observedAt);
  if (
    [currentEffective, currentObserved, incomingEffective, incomingObserved].some((v) => v === null)
  )
    return 'conflict';
  const ce = currentEffective!,
    co = currentObserved!,
    ie = incomingEffective!,
    io = incomingObserved!;
  if (current.hash === incoming.hash) return ce === ie && co === io ? 'duplicate' : 'conflict';
  if (ie < ce || (ie === ce && io < co)) return 'stale';
  if ((ie === ce && io === co) || (ie > ce && io < co)) return 'conflict';
  return 'newer';
}

export function canResolveExternalOrder(
  status: ReconciliationStatus,
  outcome: ReconciliationStatus,
  pendingUntrustedIntake = false,
): boolean {
  return (
    ![
      'unmatched',
      'resolved_official_wins',
      'resolved_local_verified',
      'ignored_with_reason',
    ].includes(status) &&
    !(pendingUntrustedIntake && ['matched', 'resolved_official_wins'].includes(outcome)) &&
    [
      'matched',
      'resolved_official_wins',
      'resolved_local_verified',
      'ignored_with_reason',
    ].includes(outcome) &&
    status !== outcome
  );
}
