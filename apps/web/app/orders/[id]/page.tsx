import { OrderDetail } from '../../order-detail';

export const metadata = { title: 'Detalle de orden · RPT' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderDetail id={id} />;
}
