import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useAsync, type BatchRow, type DemoUser } from '../api';
import { Alert, Badge, Empty, Skeleton, STATUS_LABEL, errorText, fmtDateTime, humanize, since, useNow } from '../components';
import { useLiveReload } from '../useEvents';

type Stats = {
  batches: Record<string, number>;
  certificates: { total: number; valid: number; revoked: number };
  deliveries: Record<string, number>;
  escalated: number;
};
type AuditRow = { id: string; action: string; actorId: string | null; entityType: string; entityId: string; createdAt: string };

const PIPELINE = ['DRAFT', 'DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW', 'RETURNED', 'APPROVED', 'ISSUED', 'REJECTED'];

export default function StateDashboard() {
  const now = useNow();
  const stats = useAsync(() => api<Stats>('/stats'), []);
  const stuck = useAsync(() => api<{ batches: BatchRow[] }>('/batches?escalated=true').then((r) => r.batches), []);
  const waiting = useAsync(
    () => api<{ batches: BatchRow[] }>('/batches?status=STATE_REVIEW').then((r) => r.batches.filter((b) => !b.decidedByMe)),
    [],
  );
  const activity = useAsync(() => api<{ audit: AuditRow[] }>('/audit?limit=10').then((r) => r.audit), []);
  const people = useAsync(
    () => api<{ users: DemoUser[] }>('/auth/demo-users').then((r) => new Map(r.users.map((u) => [u.id, u.name]))),
    [],
  );
  useLiveReload(() => {
    void stats.reload();
    void stuck.reload();
    void waiting.reload();
    void activity.reload();
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
  const totalBatches = s ? PIPELINE.reduce((n, k) => n + (s.batches[k] ?? 0), 0) : 0;

  return (
    <section>
      <div className="page-head">
        <h1>State overview</h1>
      </div>
      {flash && (
        <Alert tone={flash.tone} onClose={() => setFlash(null)}>
          {flash.text}
        </Alert>
      )}
      {stats.error && <Alert>Could not load figures: {errorText(stats.error)}</Alert>}

      {!s ? (
        <Skeleton rows={2} />
      ) : (
        <div className="kpis">
          <Kpi label="In review" value={inReview} />
          <Kpi label="Escalated" value={s.escalated} tone={s.escalated > 0 ? 'danger' : undefined} />
          <Kpi label="Certificates issued" value={s.certificates.total} />
          <Kpi label="Revoked" value={s.certificates.revoked} />
          <Kpi
            label="Deliveries pending / failed"
            value={`${s.deliveries.PENDING ?? 0} / ${s.deliveries.FAILED ?? 0}`}
            tone={(s.deliveries.FAILED ?? 0) > 0 ? 'danger' : undefined}
          />
        </div>
      )}

      <div className="card">
        <h2>Waiting for your approval</h2>
        {waiting.error && <Alert>{errorText(waiting.error)}</Alert>}
        {waiting.loading && !waiting.data ? (
          <Skeleton rows={2} />
        ) : !waiting.data?.length ? (
          <Empty title="Nothing to approve">Batches appear here once the district (and quality, for large batches) has approved them.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Candidates</th>
                  <th>Waiting</th>
                </tr>
              </thead>
              <tbody>
                {waiting.data.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link to={`/batches/${b.id}`}>{b.courseName}</Link>
                      <div className="muted small">{b.centre?.name}</div>
                    </td>
                    <td>{b.candidateCount}</td>
                    <td>{since(b.stageEnteredAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="dash-grid">
        <div className="card">
          <h2>Needs attention</h2>
          {stuck.error && <Alert>{errorText(stuck.error)}</Alert>}
          {stuck.loading && !stuck.data ? (
            <Skeleton rows={3} />
          ) : !stuck.data?.length ? (
            <Empty title="Nothing is past its SLA">Batches that wait too long in a review stage appear here automatically.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>Stage</th>
                    <th>Waiting</th>
                  </tr>
                </thead>
                <tbody>
                  {stuck.data.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <Link to={`/batches/${b.id}`}>{b.courseName}</Link>
                        <div className="muted small">{b.centre?.name}</div>
                      </td>
                      <td>
                        <Badge status={b.status} />
                      </td>
                      <td title={`Escalated ${fmtDateTime(b.escalatedAt)}`}>{since(b.stageEnteredAt, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2>Delivery health</h2>
          {s && (
            <dl className="delivery-health">
              {(['SENT', 'PENDING', 'FAILED', 'CANCELLED'] as const).map((k) => (
                <div key={k}>
                  <dt>
                    <Badge status={k} />
                  </dt>
                  <dd>{s.deliveries[k] ?? 0}</dd>
                </div>
              ))}
            </dl>
          )}
          <button
            className="btn btn-secondary"
            onClick={retry}
            disabled={busy || !s || !(s.deliveries.FAILED ?? 0)}
            title={s && !(s.deliveries.FAILED ?? 0) ? 'No failed deliveries to retry' : undefined}
          >
            {busy ? 'Retrying…' : 'Retry failed deliveries'}
          </button>
          {s && !(s.deliveries.FAILED ?? 0) && <p className="muted small">No failed deliveries right now.</p>}
        </div>
      </div>

      <div className="card">
        <h2>Pipeline</h2>
        {!s ? (
          <Skeleton rows={1} />
        ) : totalBatches === 0 ? (
          <p className="muted">No batches yet.</p>
        ) : (
          <>
            <div className="pipeline-bar" role="img" aria-label={PIPELINE.map((k) => `${STATUS_LABEL[k]}: ${s.batches[k] ?? 0}`).join(', ')}>
              {PIPELINE.filter((k) => s.batches[k]).map((k) => (
                <span key={k} className={`pipeline-seg seg-${k.toLowerCase()}`} style={{ flexGrow: s.batches[k] }} title={`${STATUS_LABEL[k]}: ${s.batches[k]}`} />
              ))}
            </div>
            <ul className="pipeline-legend">
              {PIPELINE.map((k) => (
                <li key={k}>
                  <Link to={`/batches?tab=${k}`}>
                    <span className={`swatch seg-${k.toLowerCase()}`} aria-hidden="true" />
                    {STATUS_LABEL[k]} <strong>{s.batches[k] ?? 0}</strong>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="card">
        <h2>Recent activity</h2>
        {activity.error && <Alert>{errorText(activity.error)}</Alert>}
        {activity.loading && !activity.data ? (
          <Skeleton rows={5} />
        ) : !activity.data?.length ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <ol className="timeline">
            {activity.data.map((a) => (
              <li key={a.id}>
                <span className="timeline-time">{fmtDateTime(a.createdAt)}</span>
                <span>
                  <strong>{humanize(a.action)}</strong>{' '}
                  <span className="muted">by {a.actorId ? (people.data?.get(a.actorId) ?? 'user') : 'system'}</span>
                  {a.entityType === 'Batch' && (
                    <span className="timeline-meta">
                      <Link to={`/batches/${a.entityId}`}>Open batch</Link>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number | string; tone?: 'danger' }) {
  return (
    <div className={`tile ${tone ? `tile-${tone}` : ''}`}>
      <span className="tile-value">{value}</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}
