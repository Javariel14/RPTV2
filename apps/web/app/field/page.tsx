import { cookies } from 'next/headers';
import { FieldWorkspace } from '../field-workspace';

export default async function FieldPage() {
  const theme = (await cookies()).get('rpt.theme')?.value ?? 'system';
  return <FieldWorkspace initialTheme={['light', 'dark'].includes(theme) ? theme : 'system'} />;
}
