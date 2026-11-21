import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BatchStatus, Role } from './api';

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  DISTRICT_REVIEW: 'District review',
  QUALITY_REVIEW: 'Quality review',
  STATE_REVIEW: 'State review',
  APPROVED: 'Approved',
  ISSUED: 'Issued',
  RETURNED: 'Returned',
  REJECTED: 'Rejected',
  VALID: 'Valid',
  REVOKED: 'Revoked',
  PENDING: 'Pending',
  SENT: 'Sent',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export const ROLE_LABEL: Record<Role, string> = {
  CENTRE: 'Training centre',
  DISTRICT_OFFICER: 'District officer',
  QUALITY: 'Quality reviewer',
  STATE: 'State office',
};

/** The review status each reviewer role acts on. */
export const REVIEW_STATUS: Partial<Record<Role, BatchStatus>> = {
  DISTRICT_OFFICER: 'DISTRICT_REVIEW',
  QUALITY: 'QUALITY_REVIEW',
  STATE: 'STATE_REVIEW',
};

/**
 * One colour per status, used by every badge in the app (styles.css documents the same map):
 * neutral: Draft, Cancelled · info: the three review stages · success: Approved, Issued, Valid, Sent
 * warn: Returned, Pending · danger: Rejected, Revoked, Failed (and the Escalated badge).
 */
const TONE: Record<string, string> = {
  DRAFT: 'neutral',
  DISTRICT_REVIEW: 'info',
  QUALITY_REVIEW: 'info',
  STATE_REVIEW: 'info',
  APPROVED: 'success',
  ISSUED: 'success',
  RETURNED: 'warn',
  REJECTED: 'danger',
  VALID: 'success',
  REVOKED: 'danger',
  PENDING: 'warn',
  SENT: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

export function Badge({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`badge badge-${TONE[status] ?? 'neutral'}`}>{children ?? STATUS_LABEL[status] ?? status}</span>;
}

export function EscalatedBadge() {
  return <span className="badge badge-danger" title="Waiting longer than the SLA">Escalated</span>;
}

export function Alert({ tone = 'danger', children, onClose }: { tone?: 'danger' | 'success' | 'warn' | 'info'; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div>{children}</div>
      {onClose && (
        <button className="alert-close" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialog: Esc closes, Tab is trapped inside, and focus returns to the element that opened it. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const box = ref.current;
    if (box && !box.contains(document.activeElement)) (box.querySelector<HTMLElement>(FOCUSABLE) ?? box).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return closeRef.current();
      if (e.key !== 'Tab' || !box) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const [first, last] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      trigger?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function since(iso: string | null | undefined, now: number) {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';

/** One format everywhere: "21 Nov 2026, 11:22 IST". */
export const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });
  return `${fmtDate(iso)}, ${time} IST`;
};

/** The CertiFlow mark: a document with a check, in brand navy. Decorative; pair it with the wordmark. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="28" height="28" rx="7" fill="var(--primary)" />
      <path d="M10 9h8l4 4v10a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="m12.5 17.5 2.5 2.5 4.5-5" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Small line icons (aria-hidden); text labels always sit next to them. */
export function Icon({ name, size = 16 }: { name: 'check' | 'cross' | 'chevron' | 'menu' | 'copy'; size?: number }) {
  const paths: Record<string, string> = {
    check: 'M5 12.5l4.5 4.5L19 7.5',
    cross: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    chevron: 'M9.5 6l6 6-6 6',
    menu: 'M4 7h16M4 12h16M4 17h16',
    copy: 'M9 9h10v10H9zM5 15V5h10',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}

export const humanize = (code: string) => (code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ')).replace(/^Csv\b/, 'CSV');

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
