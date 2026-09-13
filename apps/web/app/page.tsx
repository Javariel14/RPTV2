import { ReferenceWorkspace } from './reference-workspace';
import { cookies } from 'next/headers';
export default async function Home() {
  const theme = (await cookies()).get('rpt.theme')?.value ?? 'system';
  return <ReferenceWorkspace initialTheme={['light', 'dark'].includes(theme) ? theme : 'system'} />;
}
