'use client';
import { useEffect, useRef, useState } from 'react';
import { orderHistoryPage, type OrderHistoryItem } from '@rpt/contracts';
import { Button } from '@rpt/ui';
import { OrderState } from './commercial-shell';
import { historyView } from './order-view-model';
import { orderRequest, OrderHttpError, protectedOrderDenial } from './use-order-data';

export function OrderHistory({
  id,
  onDenied,
}: {
  id: string;
  onDenied: (error: OrderHttpError) => void;
}) {
  const [items, setItems] = useState<OrderHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<OrderHttpError>();
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  async function load(next?: string) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (next) query.set('cursor', next);
      const page = await orderRequest(`/${id}/history?${query}`, orderHistoryPage, current.signal);
      if (current.signal.aborted || controller.current !== current) return;
      setItems((previous) =>
        next
          ? [...new Map([...previous, ...page.items].map((item) => [item.id, item])).values()].sort(
              (a, b) => a.sequence - b.sequence,
            )
          : page.items,
      );
      setCursor(page.nextCursor);
    } catch (reason) {
      if (!current.signal.aborted && controller.current === current) {
        const failure =
          reason instanceof OrderHttpError ? reason : new OrderHttpError(503, 'UNAVAILABLE');
        if (protectedOrderDenial(failure)) {
          setItems([]);
          setCursor(null);
          onDenied(failure);
        }
        setError(failure);
      }
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
    // Denial clears the parent; successful detail revalidation remounts this history.
  }, [id, revision]);
  return (
    <section className="order-section" aria-labelledby="order-history-title" aria-busy={loading}>
      <h2 id="order-history-title">Historial de ciclo de vida</h2>
      {(error || (loading && !items.length)) && (
        <OrderState error={error} retry={() => setRevision((n) => n + 1)} />
      )}
      {(items.length > 0 || (!loading && !error)) && (
        <>
          <ol className="order-history">
            {items.map(historyView).map((event) => (
              <li key={event.id}>
                <span className="order-eyebrow">Secuencia {event.sequence}</span>
                <h3>{event.label}</h3>
                <p>{event.stateLabel}</p>
                <p>
                  {event.operation === 'technical_bootstrap'
                    ? 'Inicialización técnica del historial canónico.'
                    : event.reason}
                </p>
                <time dateTime={event.recordedAt}>{event.recordedLabel}</time>
              </li>
            ))}
          </ol>
          {!items.length && <p role="status">No hay eventos disponibles.</p>}
          {cursor && (
            <Button disabled={loading} onClick={() => void load(cursor)}>
              Cargar más historial
            </Button>
          )}
        </>
      )}
    </section>
  );
}
