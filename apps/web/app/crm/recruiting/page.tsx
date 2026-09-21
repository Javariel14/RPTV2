import { cookies } from 'next/headers';
import { RecruitingWorkspace } from '../../recruiting-workspace';

export default async function RecruitingCrm() {
  const theme = (await cookies()).get('rpt.theme')?.value ?? 'system';
  return (
    <RecruitingWorkspace initialTheme={['light', 'dark'].includes(theme) ? theme : 'system'} />
  );
}
