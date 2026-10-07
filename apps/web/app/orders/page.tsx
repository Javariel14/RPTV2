import type { Metadata } from 'next';
import { OrderWorkspace } from '../order-workspace';
export const metadata: Metadata = {
  title: 'Órdenes · RPT',
  description: 'Consulta autorizada de órdenes canónicas. Laboratorio con datos sintéticos.',
};
export default function OrdersPage() {
  return <OrderWorkspace />;
}
