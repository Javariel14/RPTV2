'use client';
import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return <button type="button" className={`button ${variant} ${className}`} {...props} />;
}
export function Panel({
  title,
  children,
  closeLabel,
  onClose,
  kind = 'drawer',
}: {
  title: string;
  children: ReactNode;
  closeLabel: string;
  onClose: () => void;
  kind?: 'drawer' | 'sheet' | 'dialog';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!trigger.current && document.activeElement instanceof HTMLElement)
      trigger.current = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      queueMicrotask(() => trigger.current?.focus());
    };
  }, []);
  return (
    <dialog
      className={`panel ${kind}`}
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
        const first = focusable.at(0);
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      aria-labelledby={titleId}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <Button onClick={onClose} aria-label={closeLabel}>
          ×
        </Button>
      </header>
      <div className="panel-body">{children}</div>
    </dialog>
  );
}
export function State({
  title,
  detail,
  children,
  role = 'status',
}: {
  title: string;
  detail: string;
  children?: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <section className="state" role={role}>
      <h2>{title}</h2>
      <p>{detail}</p>
      {children}
    </section>
  );
}
