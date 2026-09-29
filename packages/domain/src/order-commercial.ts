import type { OrderCommercialStatus } from '@rpt/contracts';
/** Internal commercial terminal states never imply refunds or external cancellation. */
export function nextOrderCommercialStatus(
  state: OrderCommercialStatus,
  operation: 'cancel' | 'replace',
) {
  if (state !== 'created') return null;
  return operation === 'cancel' ? ('cancelled' as const) : ('superseded' as const);
}
