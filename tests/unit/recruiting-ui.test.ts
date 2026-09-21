import assert from 'node:assert/strict';
import test from 'node:test';
import { recruitingCatalogs } from '../../apps/web/app/recruiting-catalog.js';

const visibleKeys = [
  'new',
  'initial_contact',
  'qualified',
  'interview_to_schedule',
  'interview_scheduled',
  'interviewed',
  'evaluation',
  'followup_decision',
  'onboarding',
  'activated',
  'data_validated',
  'duplicate_suspected',
  'first_contact_pending',
  'contacted',
  'no_answer',
  'invalid_number',
  'message_sent',
  'interest_qualified',
  'interview_proposed',
  'confirmation_pending',
  'confirmed',
  'no_response',
  'reschedule_requested',
  'rescheduled',
  'cancelled',
  'no_show',
  'attended',
  'evaluation_pending',
  'evaluated',
  'nurture',
  'not_interested',
  'registration_started',
  'onboarding_started',
  'training_pending',
  'withdrawn',
  'reassign_owner',
  'complete_followup',
];

void test('Recruiting UI has complete ES/EN/FR/PT operational labels', () => {
  for (const [locale, catalog] of Object.entries(recruitingCatalogs)) {
    for (const key of visibleKeys) {
      assert.ok(catalog[key], `${locale}:${key}`);
      assert.equal(catalog[key]!.includes('_'), false, `${locale}:${key} leaks an internal id`);
    }
    assert.ok(catalog.priority.length > 8);
    assert.match(catalog.operational, /diagn/i);
  }
  assert.equal(recruitingCatalogs.fr.initial_contact, 'Premier contact');
  assert.equal(recruitingCatalogs.pt.initial_contact, 'Contato inicial');
});
