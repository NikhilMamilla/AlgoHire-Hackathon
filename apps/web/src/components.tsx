import { useEffect, useState, type ReactNode } from 'react';
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

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
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

export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '—';

export const humanize = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
