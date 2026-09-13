import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/manrope';
import '@rpt/design-tokens/tokens.css';
import './styles.css';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
export const metadata: Metadata = {
  title: 'RPT · Foundation',
  description: 'Referencia Foundation con datos ficticios. Sin acceso productivo.',
  robots: { index: false, follow: false },
  icons: { icon: '/rpt-symbol-color.svg' },
};
export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (process.env.RPT_ENV && !['local', 'test'].includes(process.env.RPT_ENV))
    throw new Error('FOUNDATION_WEB_NOT_APPROVED_FOR_DEPLOYMENT');
  const theme = (await cookies()).get('rpt.theme')?.value ?? 'system';
  return (
    <html lang="es" data-theme={['light', 'dark'].includes(theme) ? theme : 'system'}>
      <body>{children}</body>
    </html>
  );
}
