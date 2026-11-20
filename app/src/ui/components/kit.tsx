import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Measured } from '../../engine/frames';
import { measuredLine, showMeasured, showNumber, type Shown } from '../measured';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost' | 'default'; size?: 'big' | 'small' | 'normal'; block?: boolean };

export function Button({ variant = 'default', size = 'normal', block, className = '', type = 'button', ...rest }: BtnProps) {
  const cls = ['btn', variant !== 'default' ? variant : '', size !== 'normal' ? size : '', block ? 'block' : '', className].filter(Boolean).join(' ');
  return <button type={type} className={cls} {...rest} />;
}

export function Card({ children, className = '', tight }: { children: ReactNode; className?: string; tight?: boolean }) {
  return <section className={`card ${tight ? 'tight' : ''} ${className}`}>{children}</section>;
}

export function Badge({ children, tone = 'default', title }: { children: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'bad' | 'accent'; title?: string }) {
  return (
    <span className={`badge ${tone === 'default' ? '' : tone}`} title={title}>
      {children}
    </span>
  );
}

export function Note({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'warn' | 'bad' | 'ok' }) {
  return <div className={`note ${tone === 'default' ? '' : tone}`} role={tone === 'bad' || tone === 'warn' ? 'alert' : undefined}>{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A measured value, or "not measured" with its reason. Never zero, never the last value. */
export function Val({ m, unit = '', scale = 1, className = '' }: { m: Measured | null | undefined; unit?: string; scale?: number; className?: string }) {
  return <Shown_ s={showMeasured(m, unit, scale)} className={className} />;
}

export function Num({ v, unit = '', se }: { v: number | null | undefined; unit?: string; se?: number | null }) {
  return <Shown_ s={showNumber(v, unit, se)} />;
}

function Shown_({ s, className = '' }: { s: Shown; className?: string }) {
  if (s.measured) return <span className={`val ${className}`}>{s.text}</span>;
  return (
    <span className={`nm ${className}`}>
      {s.text}
      <small>{s.reason}</small>
    </span>
  );
}

export { measuredLine };

export function Modal({ title, children, onClose, actions }: { title: string; children: ReactNode; onClose: () => void; actions: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.querySelector<HTMLElement>('button')?.focus();
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        <div className="row">{actions}</div>
      </div>
    </div>
  );
}

export function Toast({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="toast" role="status">
      <p>{children}</p>
      <Button size="small" variant="ghost" onClick={onClose} aria-label="Dismiss message">
        Dismiss
      </Button>
    </div>
  );
}

const ICONS: Record<string, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  programs: 'M4 6h16M4 12h16M4 18h10',
  profile: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  anchor: 'M12 3v4m0 0a2 2 0 100 4 2 2 0 000-4zm0 4v13M5 14c0 4 3 6 7 6s7-2 7-6M3 14h4m10 0h4',
  history: 'M12 7v5l3 2M4 12a8 8 0 108-8 8 8 0 00-6 2.7L4 9M4 4v5h5',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-1-3-2 .5-1.5-1.5L17 5l-3-1-1 2h-2L10 4 7 5l.5 2L6 8.5 4 8l-1 3 2 1v1l-2 1 1 3 2-.5L7.5 18 7 20l3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3-2-1z',
};

export function Icon({ name }: { name: keyof typeof ICONS | string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.home} />
    </svg>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="hero">
      <div className="row split">
        <h1>{title}</h1>
        {actions}
      </div>
      {sub ? <p className="dim">{sub}</p> : null}
    </header>
  );
}

export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
