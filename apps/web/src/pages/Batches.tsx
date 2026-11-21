import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, useAsync, type BatchRow, type BatchStatus } from '../api';
import { useAuth } from '../App';
import { Alert, Badge, Empty, EscalatedBadge, Modal, REVIEW_STATUS, STATUS_LABEL, Skeleton, errorText, since, useNow } from '../components';
import { useLiveReload } from '../useEvents';

const STATUSES: BatchStatus[] = ['DRAFT', 'DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW', 'RETURNED', 'APPROVED', 'ISSUED', 'REJECTED'];
const REVIEW: BatchStatus[] = ['DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW'];

export default function Batches() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const list = useAsync(() => api<{ batches: BatchRow[] }>('/batches'), []);
  useLiveReload(list.reload);
  const [creating, setCreating] = useState(false);

  if (!user) return null;
  const myStatus = REVIEW_STATUS[user.role];
  const tabs: { key: string; label: string; match: (b: BatchRow) => boolean }[] = [
    ...(myStatus ? [{ key: 'mine', label: 'Waiting for me', match: (b: BatchRow) => b.status === myStatus && !b.decidedByMe }] : []),
    { key: 'all', label: 'All', match: () => true },
    ...(user.role === 'STATE' ? [{ key: 'escalated', label: 'Escalated', match: (b: BatchRow) => !!b.escalatedAt && REVIEW.includes(b.status) }] : []),
    ...STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s], match: (b: BatchRow) => b.status === s })),
  ];
  const tab = tabs.find((t) => t.key === params.get('tab')) ?? tabs[0];
  const batches = list.data?.batches ?? [];
  const rows = batches.filter(tab.match);

  return (
    <section>
      <div className="page-head">
        <h1>Batches</h1>
        {user.role === 'CENTRE' && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            New batch
          </button>
        )}
      </div>

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === tab.key}
            className={`tab ${t.key === tab.key ? 'tab-active' : ''}`}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
          >
            {t.label}
            <span className="tab-count">{batches.filter(t.match).length}</span>
          </button>
        ))}
      </div>

      {list.error && <Alert>Could not load batches: {errorText(list.error)}</Alert>}
      {list.loading && !list.data ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <Empty title={tab.key === 'mine' ? 'Nothing is waiting for you' : 'No batches here'}>
          {user.role === 'CENTRE' && batches.length === 0 ? 'Create a batch, upload its candidate CSV and submit it for review.' : 'New batches will appear here live.'}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Course</th>
                <th>Centre</th>
                <th className="num">Candidates</th>
                <th>Status</th>
                <th>Approvals</th>
                <th>In stage</th>
                <th>Round</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} onClick={() => navigate(`/batches/${b.id}`)}>
                  <td>
                    <Link to={`/batches/${b.id}`} onClick={(e) => e.stopPropagation()}>
                      {b.courseName}
                    </Link>
                  </td>
                  <td>{b.centre?.name ?? '—'}</td>
                  <td className="num">{b.candidateCount}</td>
                  <td>
                    <span className="badges">
                      <Badge status={b.status} />
                      {b.escalatedAt && REVIEW.includes(b.status) && <EscalatedBadge />}
                    </span>
                  </td>
                  <td>{b.status === 'DISTRICT_REVIEW' ? `${b.approvals}/2` : '—'}</td>
                  <td>{since(b.stageEnteredAt ?? b.createdAt, now)}</td>
                  <td>{b.round}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <NewBatchModal onClose={() => setCreating(false)} onCreated={(id) => navigate(`/batches/${id}`)} />}
    </section>
  );
}

function NewBatchModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [courseName, setCourseName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { batch } = await api<{ batch: { id: string } }>('/batches', { json: { courseName: courseName.trim() } });
      onCreated(batch.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="New batch" onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Course name</span>
          <input autoFocus value={courseName} onChange={(e) => setCourseName(e.target.value)} minLength={2} maxLength={200} required placeholder="e.g. Retail Sales Associate" />
        </label>
        {error && <Alert>{error}</Alert>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || courseName.trim().length < 2}>
            {busy ? 'Creating…' : 'Create batch'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
