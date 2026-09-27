/** Decisions are immutable. Supersession changes actionability, never historical truth. */
export function quoteApprovalState(decision: 'approved' | 'rejected' | null, current: boolean) {
  return {
    status: decision ?? (current ? 'pending' : 'superseded'),
    actionable: current && decision === null,
  };
}
