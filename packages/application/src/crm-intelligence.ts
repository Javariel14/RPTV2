import type {
  CrmIntelligence,
  CrmIntelligenceReason,
  CrmNextBestAction,
  CrmScoreReason,
  CrmStage,
} from '@rpt/contracts';

export interface CrmIntelligenceSignals {
  opportunityId: string;
  stage: CrmStage;
  nextAction: string;
  nextAt: string | null;
  updatedAt: string;
  asOf: string;
  lastActivityAt: string | null;
  overdueTaskCount: number;
  overdueTaskId: string | null;
  pendingObjectionCount: number;
  pendingCommitmentCount: number;
  futureAppointmentAt: string | null;
  futureAppointmentId: string | null;
  orderSimulatedStatus: string | null;
}

const DAY = 86_400_000;
const RULE_VERSION = 'commercial-beta-v1' as const;

export function deriveCrmIntelligence(signals: CrmIntelligenceSignals): CrmIntelligence {
  const now = new Date(signals.asOf).getTime();
  const updatedAge = ageInDays(signals.updatedAt, now);
  const activityAge = signals.lastActivityAt ? ageInDays(signals.lastActivityAt, now) : Infinity;
  const closed = ['won', 'won_simulated', 'lost'].includes(signals.stage);
  const missingNextAction = !closed && (!signals.nextAction || signals.nextAction === 'none');
  const overdueNextAction =
    !closed && signals.nextAt !== null && new Date(signals.nextAt).getTime() < now;
  const scheduledAppointment =
    signals.futureAppointmentAt !== null && new Date(signals.futureAppointmentAt).getTime() >= now;
  const inactiveDays = Math.min(activityAge, updatedAge);

  const reasons = new Set<CrmIntelligenceReason>();
  if (closed) reasons.add('closed_stage');
  if (activityAge <= 3) reasons.add('recent_activity');
  if (updatedAge <= 3) reasons.add('recent_update');
  if (!closed && inactiveDays >= 14) reasons.add('inactive_14d');
  else if (!closed && inactiveDays >= 7) reasons.add('inactive_7d');
  if (signals.overdueTaskCount > 0) reasons.add('overdue_task');
  if (overdueNextAction) reasons.add('overdue_next_action');
  if (missingNextAction) reasons.add('missing_next_action');
  if (signals.pendingObjectionCount > 0) reasons.add('pending_objection');
  if (signals.pendingCommitmentCount > 0) reasons.add('pending_commitment');
  if (scheduledAppointment) reasons.add('scheduled_appointment');

  const relationshipHealthReasons = [...reasons];
  const relationshipHealth = closed
    ? 'healthy'
    : signals.overdueTaskCount > 0 || inactiveDays >= 14
      ? 'at_risk'
      : missingNextAction ||
          overdueNextAction ||
          inactiveDays >= 7 ||
          signals.pendingObjectionCount > 0 ||
          signals.pendingCommitmentCount > 0
        ? 'attention'
        : 'healthy';
  const impacts: Record<CrmIntelligenceReason, number> = {
    recent_activity: 15,
    recent_update: 5,
    inactive_7d: -8,
    inactive_14d: -15,
    overdue_task: -25,
    overdue_next_action: -15,
    missing_next_action: -15,
    pending_objection: -10,
    pending_commitment: -5,
    scheduled_appointment: 10,
    closed_stage: 15,
  };
  const scoreReasons: CrmScoreReason[] = relationshipHealthReasons.map((code) => ({
    code,
    impact: impacts[code],
  }));
  const operationalScore = clamp(
    50 + scoreReasons.reduce((total, component) => total + component.impact, 0),
  );
  const nextBestAction = recommend(signals, {
    scheduledAppointment,
    missingNextAction,
    overdueNextAction,
  });
  return {
    relationshipHealth,
    relationshipHealthReasons,
    operationalScore,
    scoreReasons,
    nextBestAction,
    nextBestActionReason: nextBestAction.reason,
    intelligenceCalculatedAt: signals.asOf,
    intelligenceRuleVersion: RULE_VERSION,
  };
}

function recommend(
  signals: CrmIntelligenceSignals,
  state: { scheduledAppointment: boolean; missingNextAction: boolean; overdueNextAction: boolean },
): CrmNextBestAction {
  let type: CrmNextBestAction['type'];
  let reason: CrmNextBestAction['reason'];
  let priority: CrmNextBestAction['priority'] = 'normal';
  let reference: CrmNextBestAction['reference'] = {
    type: 'opportunity',
    id: signals.opportunityId,
  };
  if (signals.stage === 'won_simulated') {
    type = stageAction(signals.stage, signals.orderSimulatedStatus);
    reason = type === 'none' ? 'closed_stage' : 'stage_next_step';
    priority = type === 'none' ? 'low' : 'normal';
  } else if (['won', 'lost'].includes(signals.stage)) {
    type = 'none';
    reason = 'closed_stage';
    priority = 'low';
  } else if (signals.overdueTaskCount > 0 && signals.overdueTaskId) {
    type = 'complete_task';
    reason = 'overdue_task';
    priority = 'high';
    reference = { type: 'task', id: signals.overdueTaskId };
  } else if (signals.pendingObjectionCount > 0) {
    type = 'entry';
    reason = 'pending_objection';
    priority = 'high';
  } else if (signals.pendingCommitmentCount > 0) {
    type = 'entry';
    reason = 'pending_commitment';
  } else if (state.scheduledAppointment && signals.futureAppointmentId) {
    type = 'prepare_appointment';
    reason = 'scheduled_appointment';
    reference = { type: 'appointment', id: signals.futureAppointmentId };
  } else if (state.missingNextAction || state.overdueNextAction) {
    type = signals.stage === 'new' || signals.stage === 'contacted' ? 'appointment' : 'entry';
    reason = state.overdueNextAction ? 'overdue_next_action' : 'missing_next_action';
    priority = state.overdueNextAction ? 'high' : 'normal';
  } else {
    type = stageAction(signals.stage, signals.orderSimulatedStatus);
    reason = type === 'none' ? 'closed_stage' : 'stage_next_step';
    priority = type === 'reconcile_mock' ? 'high' : 'normal';
  }
  return {
    type,
    reason,
    priority,
    reference,
    explanation: `rpt:${reason}`,
    generatedAt: signals.asOf,
    ruleVersion: RULE_VERSION,
    advisory: true,
  };
}

function stageAction(stage: CrmStage, orderStatus: string | null): CrmNextBestAction['type'] {
  if (stage === 'new' || stage === 'contacted') return 'appointment';
  if (stage === 'appointment') return 'demo';
  if (stage === 'demo') return 'quote';
  if (stage === 'proposal') return 'submit_order';
  if (stage === 'pending_approval') return 'reconcile_mock';
  if (stage === 'won_simulated') {
    if (orderStatus === 'approved') return 'delivery';
    if (['delivered', 'curation_pending'].includes(orderStatus ?? '')) return 'curation';
  }
  return 'none';
}

function ageInDays(value: string, now: number) {
  return Math.max(0, (now - new Date(value).getTime()) / DAY);
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
