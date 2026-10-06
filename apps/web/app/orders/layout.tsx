import { cookies } from 'next/headers';
import { Suspense, type ReactNode } from 'react';
import { CommercialShell } from '../commercial-shell';
export default async function OrdersLayout({ children }: { children: ReactNode }) {
  const value = (await cookies()).get('rpt.theme')?.value;
  return (
    <Suspense fallback={<p role="status">Cargando espacio comercial…</p>}>
      <CommercialShell initialTheme={value === 'light' || value === 'dark' ? value : 'system'}>
        {children}
      </CommercialShell>
    </Suspense>
  );
}
