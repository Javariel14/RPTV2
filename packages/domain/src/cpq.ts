import type { z } from 'zod';
import type { quoteStatus, quoteTransition } from '@rpt/contracts';

/** Lifecycle only. All commercial math remains in the E3B1 calculator. */
export function nextQuoteStatus(
  status: z.infer<typeof quoteStatus>,
  action: z.infer<typeof quoteTransition>['action'],
) {
  const target = {
    issue: 'issued',
    accept: 'accepted',
    reject: 'rejected',
    expire: 'expired',
    cancel: 'cancelled',
  } as const;
  const allowed =
    action === 'issue'
      ? status === 'draft'
      : action === 'accept' || action === 'reject'
        ? status === 'issued'
        : status === 'draft' || status === 'issued';
  if (!allowed) throw new RangeError('invalid quote transition');
  return target[action];
}
