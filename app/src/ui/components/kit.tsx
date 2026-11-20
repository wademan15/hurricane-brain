import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Measured } from '../../engine/frames';
import { measuredLine, showFixed, showMeasured, showNumber, type Shown } from '../measured';

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

/**
 * A labelled form row. A single input is wrapped in a <label>. A group of buttons (a segmented
 * choice) must not be: a label forwards a tap on its text to the first button inside it, which
 * would change a setting, possibly one that changes a measurement. Pass `group` for those: the
 * row becomes a role="group" named by its label, and the hint describes it.
 */
export function Field({ label, hint, children, group }: { label: string; hint?: string; children: ReactNode; group?: boolean }) {
  const id = useId();
  if (group) {
    return (
      <div className="field" role="group" aria-labelledby={`${id}-l`} aria-describedby={hint ? `${id}-h` : undefined}>
        <span className="label" id={`${id}-l`}>{label}</span>
        {children}
        {hint ? <span className="hint" id={`${id}-h`}>{hint}</span> : null}
      </div>
    );
  }
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
          {o.value === value ? <span aria-hidden="true" className="seg-check">✓ </span> : null}
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

/** A 0 to 1 measured value to fixed decimals, or "not measured" with its reason. */
export function Fixed({ m, dp = 2 }: { m: Measured | null | undefined; dp?: number }) {
  return <Shown_ s={showFixed(m, dp)} />;
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

/**
 * A dialog. It uses the native <dialog> opened with showModal(), so the rest of the page is
 * inert (no Tab or screen reader access behind it), Escape closes it, and focus is kept inside.
 * Focus starts on the first button (the safe choice) and returns to what had it when it closes.
 */
export function Modal({ title, children, onClose, actions }: { title: string; children: ReactNode; onClose: () => void; actions: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    const before = document.activeElement as HTMLElement | null;
    if (el && !el.open) {
      try {
        el.showModal();
      } catch {
        el.setAttribute('open', '');
      }
    }
    el?.querySelector<HTMLElement>('button')?.focus();
    const cancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    el?.addEventListener('cancel', cancel);
    return () => {
      el?.removeEventListener('cancel', cancel);
      if (el?.open) el.close();
      if (before && before.isConnected) before.focus();
    };
  }, []);
  return (
    <dialog className="modal" ref={ref} aria-labelledby={titleId} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-body">
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="row">{actions}</div>
      </div>
    </dialog>
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
  discover: 'M12 3a9 9 0 100 18 9 9 0 000-18zM15.5 8.5l-2 5-5 2 2-5z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-1-3-2 .5-1.5-1.5L17 5l-3-1-1 2h-2L10 4 7 5l.5 2L6 8.5 4 8l-1 3 2 1v1l-2 1 1 3 2-.5L7.5 18 7 20l3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3-2-1z',
};

/** The three alignment states each have their own shape, so they differ by more than colour. */
const STATE_ICONS = {
  phi: 'M12 12a1.2 1.2 0 012.4 0 3 3 0 01-6 0 5 5 0 0110 0 8 8 0 01-16 0',
  octave: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8z',
  both: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 12a1 1 0 012 0 2.5 2.5 0 01-5 0 4 4 0 018 0',
} as const;

export function StateIcon({ kind }: { kind: keyof typeof STATE_ICONS }) {
  return (
    <svg className="state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={STATE_ICONS[kind]} />
    </svg>
  );
}

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
        <h1 tabIndex={-1}>{title}</h1>
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
