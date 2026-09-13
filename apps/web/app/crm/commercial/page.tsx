import { cookies } from 'next/headers';
import { ReferenceWorkspace } from '../../reference-workspace';
export default async function CommercialCrm() {
  const theme = (await cookies()).get('rpt.theme')?.value ?? 'system';
  return (
    <ReferenceWorkspace
      persistent
      initialTheme={['light', 'dark'].includes(theme) ? theme : 'system'}
    />
  );
}
