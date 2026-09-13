'use client';
import { useEffect, useRef } from 'react';
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
    <dialog className={`panel ${kind}`} ref={ref} onCancel={onClose} aria-labelledby="panel-title">
      <header>
        <h2 id="panel-title">{title}</h2>
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
}: {
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <section className="state" role="status">
      <h2>{title}</h2>
      <p>{detail}</p>
      {children}
    </section>
  );
}
