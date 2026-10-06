'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
  CalendarDays,
  FileText,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
  UserSearch,
} from 'lucide-react';
import { Button, State } from '@rpt/ui';
import { type OrderHttpError, startOrderSession } from './use-order-data';

const routes = [
  { href: '/crm/commercial', label: 'CRM Comercial', icon: Users },
  { href: '/orders', label: 'Órdenes', icon: FileText },
  { href: '/crm/recruiting', label: 'Reclutamiento', icon: UserSearch },
  { href: '/agenda', label: 'Agenda', icon: CalendarDays },
  { href: '/field', label: 'Campo', icon: MapPin },
];
export function CommercialShell({
  children,
  initialTheme,
}: {
  children: ReactNode;
  initialTheme: string;
}) {
  const path = usePathname();
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(false);
  const navigation = routes.map(({ href, label, icon: Icon }) => (
    <Link
      key={href}
      href={href}
      className={path === href || path.startsWith(href + '/') ? 'active' : ''}
      aria-current={path === href || path.startsWith(href + '/') ? 'page' : undefined}
      title={label}
    >
      <Icon size={20} aria-hidden="true" />
      <span>{label}</span>
    </Link>
  ));
  return (
    <div className={`shell order-shell ${collapsed ? 'collapsed' : ''}`}>
      <a className="skip" href="#main">
        Ir al contenido
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Image src="/rpt-symbol-color.svg" alt="" width={40} height={32} />
          </span>
          <span className="brand-word">
            RPT<small>PERFORMANCE TRACKER</small>
          </span>
        </div>
        <div className="sidebar-rule" />
        <span className="section-label">COMERCIAL</span>
        <nav aria-label="Módulos RPT">{navigation}</nav>
        <div className="sidebar-bottom">
          <p>
            PROGRESO CON CLARIDAD<small>Lectura comercial</small>
          </p>
          <Button
            aria-label={collapsed ? 'Expandir navegación' : 'Colapsar navegación'}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </Button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <nav aria-label="Ruta de navegación" className="order-breadcrumb">
            <Link href="/crm/commercial">Comercial</Link>
            <span aria-hidden="true">/</span>
            <Link href="/orders">Órdenes</Link>
            {path !== '/orders' && (
              <>
                <span aria-hidden="true">/</span>
                <span>Detalle</span>
              </>
            )}
          </nav>
          <label>
            Tema{' '}
            <select
              value={theme}
              onChange={(event) => {
                const value = event.target.value;
                setTheme(value);
                document.documentElement.dataset.theme = value;
                document.cookie = `rpt.theme=${value}; Path=/; SameSite=Lax; Max-Age=31536000`;
              }}
            >
              <option value="system">Sistema</option>
              <option value="light">Claro</option>
              <option value="dark">Oscuro</option>
            </select>
          </label>
        </header>
        <main id="main" tabIndex={-1}>
          <p className="order-context">
            Datos sintéticos de desarrollo · Alcance autorizado por el servidor · America/Guayaquil
          </p>
          {children}
        </main>
      </div>
      <nav className="order-mobile-nav" aria-label="Módulos RPT móvil">
        {navigation}
      </nav>
    </div>
  );
}

export function OrderState({
  error,
  retry,
  reset,
}: {
  error?: OrderHttpError | undefined;
  retry: () => void;
  reset?: () => void;
}) {
  const [code, setCode] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  if (!error)
    return (
      <section className="order-loading" role="status" aria-busy="true">
        <p>Cargando órdenes…</p>
        <div className="skeleton" aria-hidden="true">
          <div />
          <div />
          <div />
        </div>
      </section>
    );
  const message =
    error.status === 401
      ? ['Sesión local requerida', 'Introduce el código del laboratorio local.']
      : error.status === 404
        ? ['Orden no disponible', 'No encontramos esta orden o no tienes acceso.']
        : error.status === 403
          ? ['Acceso no disponible', 'No tienes acceso a esta vista.']
          : error.status === 422
            ? [
                'Solicitud no válida',
                'Revisa el número de orden o reinicia los filtros y la paginación.',
              ]
            : error.status === 503
              ? ['Servicio no disponible', 'No pudimos cargar esta vista. Puedes reintentar.']
              : ['No pudimos cargar esta vista', 'Reintenta o vuelve a la lista de órdenes.'];
  return (
    <State title={message[0]!} detail={message[1]!} role="alert">
      {error.status === 401 ? (
        <form
          className="session-form"
          onSubmit={(event) => {
            event.preventDefault();
            setSigningIn(true);
            setLoginError(false);
            void startOrderSession(code)
              .then(() => {
                setCode('');
                retry();
              })
              .catch(() => setLoginError(true))
              .finally(() => setSigningIn(false));
          }}
        >
          <label>
            Código de sesión local
            <input
              type="password"
              autoComplete="off"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              maxLength={128}
            />
          </label>
          <Button type="submit" variant="primary" disabled={signingIn}>
            Iniciar sesión local
          </Button>
          {loginError && <p role="alert">Código no válido o sesión no disponible.</p>}
        </form>
      ) : (
        <div className="order-state-actions">
          <Button onClick={error.status === 422 && reset ? reset : retry}>Reintentar</Button>
          <Link href="/orders">Volver a órdenes</Link>
        </div>
      )}
      {error.requestId && (
        <p className="order-reference">Referencia de solicitud: {error.requestId}</p>
      )}
    </State>
  );
}
