export type Stage = 'new' | 'appointment' | 'demo' | 'followup';
export interface ReferenceContact {
  id: string;
  name: string;
  stage: Stage;
  owner: 'self' | 'delegated';
  due: string;
  source: 'referral' | 'event';
  activity: number;
}
export function referenceContacts(count = 20): ReferenceContact[] {
  const names = [
    'Lucía Andrade',
    'Mateo Benítez',
    'Camila del Río y Valenzuela',
    'Diego Molina',
    'Valentina Torres',
    'Emilia Santos',
    'Nicolás Paredes',
    'Sofía Cárdenas',
  ];
  const stages: Stage[] = ['new', 'appointment', 'demo', 'followup'];
  return Array.from({ length: Math.min(2000, Math.max(0, count)) }, (_, i) => ({
    id: `fixture-${i + 1}`,
    name: `${names[i % names.length]}${i >= names.length ? ` · ${i + 1}` : ''}`,
    stage: stages[i % stages.length] ?? 'new',
    owner: i % 4 === 0 ? 'delegated' : 'self',
    due: `2026-09-${String(4 + (i % 7)).padStart(2, '0')}T15:00:00Z`,
    source: i % 3 ? 'referral' : 'event',
    activity: i % 8,
  }));
}
