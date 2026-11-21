import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useAsync, type BatchRow } from '../api';
import { Alert, Badge, Empty, Skeleton, STATUS_LABEL, errorText, fmtDateTime, since, useNow } from '../components';
import { useLiveReload } from '../useEvents';

type Stats = {
  batches: Record<string, number>;
  certificates: { total: number; valid: number; revoked: number };
  deliveries: Record<string, number>;
  escalated: number;
};

const STATUS_ORDER = ['DRAFT', 'DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW', 'RETURNED', 'APPROVED', 'ISSUED', 'REJECTED'];

export default function StateDashboard() {
  const now = useNow();
  const stats = useAsync(() => api<Stats>('/stats'), []);
  const stuck = useAsync(() => api<{ batches: BatchRow[] }>('/batches?escalated=true').then((r) => r.batches), []);
  useLiveReload(() => {
    void stats.reload();
    void stuck.reload();
  });
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const retry = async () => {
    setBusy(true);
    setFlash(null);
    try {
      const { requeued } = await api<{ requeued: number }>('/deliveries/retry-failed', { method: 'POST' });
      setFlash({ tone: 'success', text: requeued ? `Re-queued ${requeued} failed deliveries.` : 'No failed deliveries to retry.' });
      void stats.reload();
    } catch (e) {
      setFlash({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const s = stats.data;
  const inReview = s ? (s.batches.DISTRICT_REVIEW ?? 0) + (s.batches.QUALITY_REVIEW ?? 0) + (s.batches.STATE_REVIEW ?? 0) : 0;

  return (
    <section>
      <div className="page-head">
        <h1>State overview</h1>
        <button className="btn btn-secondary" onClick={retry} disabled={busy}>
          {busy ? 'Retrying…' : 'Retry failed deliveries'}
        </button>
      </div>
      {flash && (
        <Alert tone={flash.tone} onClose={() => setFlash(null)}>
          {flash.text}
        </Alert>
      )}
      {stats.error && <Alert>Could not load stats: {errorText(stats.error)}</Alert>}
      {!s ? (
        <Skeleton rows={3} />
      ) : (
        <>
          <div className="tiles">
            <Tile label="Batches in review" value={inReview} />
            <Tile label="Escalated" value={s.escalated} tone={s.escalated ? 'danger' : undefined} />
            <Tile label="Certificates issued" value={s.certificates.total} />
            <Tile label="Revoked" value={s.certificates.revoked} />
            <Tile label="WhatsApp sent" value={s.deliveries.SENT ?? 0} />
            <Tile label="Delivery pending" value={s.deliveries.PENDING ?? 0} />
            <Tile label="Delivery failed" value={s.deliveries.FAILED ?? 0} tone={s.deliveries.FAILED ? 'danger' : undefined} />
          </div>
          <div className="card">
            <h2>Batches by status</h2>
            <div className="status-strip">
              {STATUS_ORDER.map((k) => (
                <Link key={k} to={`/batches?tab=${k}`} className="status-cell">
                  <span className="status-cell-n">{s.batches[k] ?? 0}</span>
                  <span className="muted small">{STATUS_LABEL[k]}</span>
                </Link>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h2>Escalated / stuck batches</h2>
        {stuck.error && <Alert>{errorText(stuck.error)}</Alert>}
        {stuck.loading && !stuck.data ? (
          <Skeleton rows={3} />
        ) : !stuck.data?.length ? (
          <Empty title="No batches are past their SLA" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Centre</th>
                  <th>Stage</th>
                  <th>Waiting</th>
                  <th>Escalated at</th>
                </tr>
              </thead>
              <tbody>
                {stuck.data.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link to={`/batches/${b.id}`}>{b.courseName}</Link>
                    </td>
                    <td>{b.centre?.name ?? '—'}</td>
                    <td>
                      <Badge status={b.status} />
                    </td>
                    <td>{since(b.stageEnteredAt, now)}</td>
                    <td>{fmtDateTime(b.escalatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <div className={`tile ${tone ? `tile-${tone}` : ''}`}>
      <span className="tile-value">{value}</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}
