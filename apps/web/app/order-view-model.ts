import type { OrderDetailRead, OrderHistoryItem, OrderListItem } from '@rpt/contracts';

export const unavailable = 'No disponible';
export function statusLabel(value: unknown) {
  return value === 'created'
    ? 'Creada'
    : value === 'cancelled'
      ? 'Cancelada'
      : value === 'superseded'
        ? 'Reemplazada'
        : unavailable;
}
export function historyLabel(value: unknown) {
  switch (value) {
    case 'initialized':
      return 'Orden creada';
    case 'technical_bootstrap':
      return 'Inicialización del sistema';
    case 'cancel':
      return 'Cancelación registrada';
    case 'replace':
      return 'Reemplazo registrado';
    default:
      return unavailable;
  }
}
export function taxLabel(value: unknown) {
  switch (value) {
    case 'tax_inclusive':
      return 'Impuesto incluido';
    case 'tax_exclusive':
      return 'Impuesto adicional';
    case 'tax_not_applicable':
      return 'Impuesto no aplicable';
    case 'tax_unknown':
      return 'Tratamiento no disponible';
    default:
      return unavailable;
  }
}

/** Presentation only: no arithmetic or binary floating-point conversion of money. */
export function exactAmount(
  value: unknown,
  currency: string,
  minorUnits: number,
  locale = 'es-EC',
) {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ||
    !/^[A-Z]{3}$/.test(currency) ||
    !Number.isInteger(minorUnits) ||
    minorUnits < 0 ||
    minorUnits > 4
  )
    return unavailable;
  try {
    const [integer, fraction = ''] = value.split('.');
    const grouping = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
      BigInt(integer!),
    );
    const decimal =
      new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')
        ?.value ?? '.';
    const digits = fraction.padEnd(minorUnits, '0');
    return `${currency} ${grouping}${digits ? decimal + digits : ''}`;
  } catch {
    return unavailable;
  }
}
export function orderDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? unavailable
    : new Intl.DateTimeFormat('es-EC', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'America/Guayaquil',
      }).format(date);
}
export function listView(order: OrderListItem) {
  return {
    ...order,
    statusLabel: statusLabel(order.status),
    createdLabel: orderDate(order.createdAt),
  };
}
export function historyView(event: OrderHistoryItem) {
  return {
    ...event,
    label: historyLabel(event.operation),
    recordedLabel: orderDate(event.recordedAt),
    stateLabel: `${event.previousStatus ? statusLabel(event.previousStatus) + ' → ' : ''}${statusLabel(event.status)}`,
  };
}
export function snapshotView(order: OrderDetailRead) {
  const snapshot = order.commercialSnapshot;
  const money = (value: unknown) => exactAmount(value, snapshot.currency, snapshot.minorUnits);
  return {
    immutable: true as const,
    money,
    lines: order.lines.map((line) => ({
      name: line.catalog.displayName,
      code: line.catalog.commercialCode,
      path: line.catalog.path.map((node) => node.name).join(' / '),
      quantity: line.commercial.quantity,
      unitPrice: money(line.commercial.unitPrice),
      base: money(line.commercial.lineBaseAmount),
      net: money(line.commercial.net),
      tax: money(line.commercial.tax),
      gross: money(line.commercial.gross),
      taxTreatment: taxLabel(line.commercial.taxTreatment),
      taxRate: line.commercial.taxRate ?? unavailable,
      adjustments: line.commercial.appliedAdjustments.map((a) => ({
        ...a,
        displayAmount: money(a.amount),
      })),
      bundle: line.bundleComposition.map(
        (item) => `${item.quantity} × ${item.catalog.displayName} (${item.catalog.commercialCode})`,
      ),
    })),
  };
}
