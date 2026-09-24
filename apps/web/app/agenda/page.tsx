import { cookies } from 'next/headers';
import { AgendaWorkspace } from '../agenda-workspace';

export default async function AgendaPage() {
  const theme = (await cookies()).get('rpt.theme')?.value ?? 'system';
  return <AgendaWorkspace initialTheme={['light', 'dark'].includes(theme) ? theme : 'system'} />;
}
