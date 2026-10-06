'use client';
import Link from 'next/link';
import { orderDetailRead } from '@rpt/contracts';
import { Button } from '@rpt/ui';
import { OrderState } from './commercial-shell';
import { OrderHistory } from './order-history';
import { orderDate, snapshotView, statusLabel } from './order-view-model';
import { useOrderData } from './use-order-data';

export function OrderDetail({ id }: { id: string }) {
  const remote = useOrderData(`/${encodeURIComponent(id)}`, orderDetailRead, true);
  const order = remote.data;
  if (!order)
    return (
      <>
        <h1>Detalle de orden</h1>
        <OrderState error={remote.error} retry={remote.refresh} />
      </>
    );
  const view = snapshotView(order),
    snapshot = order.commercialSnapshot,
    financing = snapshot.financing;
  const totals = [
    ['Subtotal', snapshot.totals.subtotal],
    ['Impuestos', snapshot.totals.taxTotal],
    ['Descuento (deducción)', snapshot.totals.discountTotal],
    ['Recargos', snapshot.totals.surchargeTotal],
    ['Total aceptado', snapshot.totals.grandTotal],
  ] as const;
  return (
    <>
      <Link href="/orders" className="order-back">
        ← Volver a órdenes
      </Link>
      <header className="page-header">
        <div>
          <p className="order-eyebrow">ORDEN CANÓNICA · SOLO LECTURA</p>
          <h1>{order.businessOrderNumber}</h1>
          <span className={`order-status order-status-${order.status}`}>
            {statusLabel(order.status)}
          </span>
        </div>
        <Button onClick={remote.refresh}>Actualizar</Button>
      </header>
      {remote.error && <OrderState error={remote.error} retry={remote.refresh} />}
      <div className="order-detail-grid">
        <section className="order-section">
          <h2>Identidad y contexto</h2>
          <dl className="order-facts">
            <dt>Creación</dt>
            <dd>
              <time dateTime={order.createdAt}>{orderDate(order.createdAt)}</time>
            </dd>
            <dt>Moneda</dt>
            <dd>{order.currency}</dd>
            <dt>Versión de ciclo</dt>
            <dd>{order.lifecycleVersion}</dd>
            <dt>Referencia de espacio</dt>
            <dd>{order.workspaceId}</dd>
            <dt>Referencia de mercado</dt>
            <dd>{order.marketId}</dd>
          </dl>
        </section>
        <section className="order-section">
          <h2>Proveniencia aceptada</h2>
          <dl className="order-facts">
            <dt>Cotización</dt>
            <dd>{order.quoteId}</dd>
            <dt>Versión de cotización</dt>
            <dd>{order.quoteVersionId}</dd>
            <dt>Aceptación</dt>
            <dd>{order.acceptanceId}</dd>
            <dt>Hash de cálculo</dt>
            <dd>{order.calculationHash}</dd>
            <dt>Lista de precios</dt>
            <dd>
              {snapshot.priceListId} · Versión {snapshot.priceListVersion}
            </dd>
            <dt>Vigencia del cálculo</dt>
            <dd>
              <time dateTime={snapshot.asOf}>{orderDate(snapshot.asOf)}</time>
            </dd>
          </dl>
        </section>
      </div>
      <section className="order-section order-snapshot">
        <h2>Condiciones comerciales aceptadas</h2>
        <p className="order-immutable">
          Snapshot aceptado e inmutable. Esta vista no modifica ni recalcula importes.
        </p>
        <dl className="order-totals">
          {totals.map(([label, amount]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {label.startsWith('Descuento') && amount !== null ? '− ' : ''}
                {view.money(amount)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="order-reference">
          Moneda {snapshot.currency} · {snapshot.minorUnits} decimales monetarios · Política de
          origen: {snapshot.roundingPolicy}
        </p>
        <h3>Líneas y catálogo aceptados</h3>
        <div className="order-lines">
          {view.lines.map((line, index) => (
            <article key={index}>
              <h4>{line.name}</h4>
              <p>
                {line.code} · {line.path}
              </p>
              <dl className="order-facts">
                <dt>Cantidad</dt>
                <dd>{line.quantity}</dd>
                <dt>Precio unitario</dt>
                <dd>{line.unitPrice}</dd>
                <dt>Base</dt>
                <dd>{line.base}</dd>
                <dt>Neto</dt>
                <dd>{line.net}</dd>
                <dt>Impuesto</dt>
                <dd>{line.tax}</dd>
                <dt>Bruto</dt>
                <dd>{line.gross}</dd>
                <dt>Tratamiento fiscal</dt>
                <dd>{line.taxTreatment}</dd>
                <dt>Tasa canónica</dt>
                <dd>{line.taxRate}</dd>
              </dl>
              {line.adjustments.length > 0 && (
                <>
                  <h5>Ajustes aceptados</h5>
                  <ul>
                    {line.adjustments.map((a) => (
                      <li key={a.id}>
                        Referencia {a.id} · Versión {a.version}: {a.displayAmount}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {line.bundle.length > 0 && (
                <>
                  <h5>Composición del conjunto</h5>
                  <ul>
                    {line.bundle.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
            </article>
          ))}
        </div>
      </section>
      {financing && (
        <section className="order-section">
          <h2>Financiamiento aceptado</h2>
          <p>
            {financing.months} meses · {financing.mode}
          </p>
          <dl className="order-facts">
            {[
              ['Anticipo', financing.downPayment],
              ['Base financiada', financing.financedBase],
              ['Saldo adicional', financing.additionalBalance],
              ['Recargo financiero', financing.surcharge],
              ['Cuota', financing.installment],
              ['Última cuota', financing.lastInstallment],
              ['Total programado', financing.scheduledTotal],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{view.money(value)}</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary>Ver cuotas aceptadas</summary>
            <ol>
              {financing.installments.map((value, index) => (
                <li key={index}>
                  Cuota {index + 1}: {view.money(value)}
                </li>
              ))}
            </ol>
          </details>
          <p className="order-reference">
            Plan {financing.planId} · Versión {financing.planVersion} · Plazo {financing.termId} ·
            Versión {financing.termVersion}
          </p>
        </section>
      )}
      <OrderHistory key={remote.dataVersion} id={order.id} onDenied={remote.invalidate} />
    </>
  );
}
