'use client';
import { useState } from 'react';
import Link from 'next/link';
import { orderListPage } from '@rpt/contracts';
import { Button, State } from '@rpt/ui';
import { useOrderData } from './use-order-data';
import { OrderState } from './commercial-shell';
import { listView } from './order-view-model';

export function OrderWorkspace() {
  const [number, setNumber] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState('10');
  const [cursors, setCursors] = useState<string[]>([]);
  const query = new URLSearchParams({ limit });
  if (search) query.set('businessOrderNumber', search);
  if (status) query.set('status', status);
  if (cursors.length) query.set('cursor', cursors.at(-1)!);
  const remote = useOrderData(`?${query}`, orderListPage);
  const rows = remote.data?.items.map(listView);
  const reset = () => {
    setNumber('');
    setSearch('');
    setStatus('');
    setCursors([]);
  };
  return (
    <>
      <header className="page-header">
        <div>
          <p className="order-eyebrow">CONSULTA COMERCIAL</p>
          <h1>Órdenes</h1>
          <p>Identidad canónica, estado y condiciones aceptadas.</p>
        </div>
        <Button onClick={remote.refresh}>Actualizar</Button>
      </header>
      <form
        className="order-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(number.trim());
          setCursors([]);
        }}
      >
        <label>
          Número de orden exacto
          <input
            type="search"
            placeholder="ORD-0000000001"
            value={number}
            maxLength={14}
            onChange={(event) => setNumber(event.target.value)}
          />
        </label>
        <Button type="submit" variant="primary">
          Buscar
        </Button>
        <label>
          Estado
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setCursors([]);
            }}
          >
            <option value="">Todos</option>
            <option value="created">Creada</option>
            <option value="cancelled">Cancelada</option>
            <option value="superseded">Reemplazada</option>
          </select>
        </label>
        <label>
          Órdenes por consulta
          <select
            value={limit}
            onChange={(event) => {
              setLimit(event.target.value);
              setCursors([]);
            }}
          >
            {['10', '25', '50'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <Button onClick={reset} variant="ghost">
          Limpiar filtros
        </Button>
      </form>
      {!remote.data ? (
        <OrderState error={remote.error} retry={remote.refresh} reset={reset} />
      ) : rows?.length === 0 ? (
        <State
          title="No hay órdenes disponibles"
          detail="No hay órdenes disponibles en este alcance con los filtros seleccionados."
        >
          <Button onClick={reset}>Limpiar filtros</Button>
        </State>
      ) : (
        <>
          <p className="order-list-meta" role="status">
            {rows!.length} órdenes en esta consulta · Más recientes primero
          </p>
          <div className="order-table data-surface">
            <table>
              <caption className="sr-only">Órdenes autorizadas</caption>
              <thead>
                <tr>
                  {[
                    'Orden',
                    'Fecha de creación',
                    'Estado',
                    'Referencia de mercado',
                    'Moneda',
                    'Versión de ciclo',
                  ].map((title) => (
                    <th scope="col" key={title}>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows!.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/orders/${row.id}`} className="order-number">
                        {row.businessOrderNumber}
                      </Link>
                    </td>
                    <td>
                      <time dateTime={row.createdAt}>{row.createdLabel}</time>
                    </td>
                    <td>
                      <span className={`order-status order-status-${row.status}`}>
                        {row.statusLabel}
                      </span>
                    </td>
                    <td>
                      <span className="order-reference" title={row.marketId}>
                        {row.marketId}
                      </span>
                    </td>
                    <td>{row.currency}</td>
                    <td>{row.lifecycleVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="order-cards">
            {rows!.map((row) => (
              <article key={row.id}>
                <Link href={`/orders/${row.id}`} className="order-number">
                  {row.businessOrderNumber}
                </Link>
                <span className={`order-status order-status-${row.status}`}>{row.statusLabel}</span>
                <time dateTime={row.createdAt}>{row.createdLabel}</time>
                <p>
                  Moneda: {row.currency} · Versión: {row.lifecycleVersion}
                </p>
                <p className="order-reference">Mercado: {row.marketId}</p>
              </article>
            ))}
          </div>
        </>
      )}
      {remote.data && (
        <nav className="order-pagination" aria-label="Paginación de órdenes">
          <Button disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
            Anterior
          </Button>
          <Button
            disabled={!remote.data.nextCursor}
            onClick={() => setCursors([...cursors, remote.data!.nextCursor!])}
          >
            Siguiente
          </Button>
        </nav>
      )}
    </>
  );
}
