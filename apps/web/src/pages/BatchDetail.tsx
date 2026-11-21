import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, downloadPdf, useAsync, type BatchDetail as Batch, type CertificateRow, type CsvError, type Decision, type User } from '../api';
import { useAuth } from '../App';
import {
  Alert,
  Badge,
  Empty,
  EscalatedBadge,
  Modal,
  REVIEW_STATUS,
  STATUS_LABEL,
  Skeleton,
  Spinner,
  errorText,
  fmtDate,
  fmtDateTime,
  humanize,
  since,
  useNow,
} from '../components';
import { useLiveReload } from '../useEvents';

const STAGE_OF: Record<string, Decision['stage']> = { DISTRICT_REVIEW: 'DISTRICT', QUALITY_REVIEW: 'QUALITY', STATE_REVIEW: 'STATE' };
const REVIEW_ROLE_LABEL: Record<string, string> = { DISTRICT_REVIEW: 'district officers', QUALITY_REVIEW: 'the quality team', STATE_REVIEW: 'the state office' };

type Flash = { tone: 'danger' | 'success'; text: string } | null;

export default function BatchDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const { user } = useAuth();
  const now = useNow();
  const batch = useAsync(() => api<{ batch: Batch }>(`/batches/${id}`).then((r) => r.batch), [id]);
  const status = batch.data?.status;
  const certs = useAsync(
    () => (status === 'ISSUED' ? api<{ certificates: CertificateRow[] }>(`/batches/${id}/certificates`).then((r) => r.certificates) : Promise.resolve([])),
    [id, status],
  );
  const [flash, setFlash] = useState<Flash>(null);

  const reloadAll = () => {
    void batch.reload();
    void certs.reload();
  };
  useLiveReload(reloadAll, (e) => e.batchId === id);

  if (batch.error && !batch.data) {
    const notFound = batch.error instanceof ApiError && batch.error.status === 404;
    return (
      <section>
        <p>
          <Link to="/batches">← Batches</Link>
        </p>
        <Alert>{notFound ? 'Batch not found, or you do not have access to it.' : errorText(batch.error)}</Alert>
      </section>
    );
  }
  if (!batch.data || !user) return <Skeleton rows={8} />;
  const b = batch.data;
  const stage = STAGE_OF[b.status];

  return (
    <section>
      <p className="crumb">
        <Link to="/batches">← Batches</Link>
      </p>
      <div className="page-head">
        <div>
          <h1>{b.courseName}</h1>
          <p className="muted">
            {b.centre?.name}
            {b.district ? ` · ${b.district.name} district` : ''}
          </p>
        </div>
        <div className="head-meta">
          <span className="badges">
            <Badge status={b.status} />
            {b.escalatedAt && stage && <EscalatedBadge />}
          </span>
          <span className="muted">
            Round {b.round}
            {stage ? ` · ${humanize(stage)} stage · ${since(b.stageEnteredAt, now)} in stage` : ''}
          </span>
        </div>
      </div>

      {flash && (
        <Alert tone={flash.tone} onClose={() => setFlash(null)}>
          {flash.text}
        </Alert>
      )}

      <ActionPanel batch={b} user={user} onDone={reloadAll} setFlash={setFlash} />

      <div className="card">
        <h2>Candidates ({b.candidates.length})</h2>
        {b.candidates.length === 0 ? (
          <Empty title="No candidates yet">{user.role === 'CENTRE' ? 'Upload a CSV above.' : 'The centre has not uploaded candidates.'}</Empty>
        ) : (
          <div className="table-wrap table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {b.candidates.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.candidateRef}</td>
                    <td>{c.fullName}</td>
                    <td className="mono">{c.phone}</td>
                    <td>{fmtDate(c.completionDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {status === 'ISSUED' && (
        <Certificates certs={certs.data} loading={certs.loading} error={certs.error} user={user} onChange={() => void certs.reload()} setFlash={setFlash} />
      )}

      <div className="card">
        <h2>Decisions</h2>
        {b.decisions.length === 0 ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Decision</th>
                  <th>Stage</th>
                  <th>Round</th>
                  <th>Reason</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {b.decisions.map((d) => (
                  <tr key={d.id} className={d.round < b.round ? 'row-faded' : ''}>
                    <td>{d.actor.name}</td>
                    <td>
                      <span className={`decision decision-${d.type.toLowerCase()}`}>{humanize(d.type)}</span>
                    </td>
                    <td>{humanize(d.stage)}</td>
                    <td>
                      {d.round}
                      {d.round < b.round ? ' (earlier round)' : ''}
                    </td>
                    <td>{d.reason ?? '—'}</td>
                    <td>{fmtDateTime(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Audit timeline</h2>
        <ol className="timeline">
          {b.audit.map((a) => (
            <li key={a.id}>
              <span className="timeline-time">{fmtDateTime(a.createdAt)}</span>
              <span>
                <strong>{humanize(a.action)}</strong> <span className="muted">by {a.actorName ?? (a.actorId ? 'user' : 'system')}</span>
                {summarize(a.metadata) && <span className="timeline-meta">{summarize(a.metadata)}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const META_KEYS = ['rowCount', 'errorCount', 'candidateCount', 'count', 'type', 'stage', 'round', 'minutesWaiting', 'reason'];
function summarize(meta: Record<string, unknown> | null) {
  if (!meta) return '';
  const parts: string[] = [];
  if (typeof meta.from === 'string' && typeof meta.to === 'string') parts.push(`${STATUS_LABEL[meta.from] ?? meta.from} → ${STATUS_LABEL[meta.to] ?? meta.to}`);
  for (const k of META_KEYS) if (meta[k] !== undefined && meta[k] !== null && meta[k] !== '') parts.push(`${k}: ${String(meta[k])}`);
  return parts.join(' · ');
}

function ActionPanel({ batch: b, user, onDone, setFlash }: { batch: Batch; user: User; onDone: () => void; setFlash: (f: Flash) => void }) {
  const stage = STAGE_OF[b.status];
  const returned = [...b.decisions].reverse().find((d) => d.type === 'RETURN');

  if (user.role === 'CENTRE' && (b.status === 'DRAFT' || b.status === 'RETURNED')) {
    return (
      <div className="card card-action">
        {b.status === 'RETURNED' && returned && (
          <Alert tone="warn">
            <strong>Returned by {returned.actor.name}:</strong> {returned.reason}
            <div className="muted small">Fix the data, re-upload the CSV and resubmit. Resubmitting starts round {b.round + 1}; earlier approvals will not count.</div>
          </Alert>
        )}
        <CentreActions batch={b} onDone={onDone} setFlash={setFlash} />
      </div>
    );
  }

  if (stage && REVIEW_STATUS[user.role] === b.status) {
    const mine = b.decisions.find((d) => d.actor.id === user.id && d.round === b.round && d.stage === stage);
    if (mine) {
      return (
        <div className="card card-action">
          <p>
            You recorded <strong>{humanize(mine.type)}</strong> on this batch in round {b.round}. {b.status === 'DISTRICT_REVIEW' ? 'Waiting for a second district officer.' : ''}
          </p>
        </div>
      );
    }
    return <ReviewActions batch={b} onDone={onDone} setFlash={setFlash} />;
  }

  const waiting = stage ? `Waiting for ${REVIEW_ROLE_LABEL[b.status]}.` : null;
  return waiting ? (
    <div className="card card-action">
      <p className="muted">{waiting}</p>
    </div>
  ) : null;
}

function CentreActions({ batch: b, onDone, setFlash }: { batch: Batch; onDone: () => void; setFlash: (f: Flash) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<CsvError[] | null>(null);
  const [busy, setBusy] = useState<'upload' | 'submit' | null>(null);
  const [inputKey, setInputKey] = useState(0);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy('upload');
    setErrors(null);
    setFlash(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const { count } = await api<{ count: number }>(`/batches/${b.id}/candidates/csv`, { form });
      setFlash({ tone: 'success', text: `Uploaded ${count} candidates. They replace any earlier upload.` });
      setFile(null);
      setInputKey((k) => k + 1);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CSV_INVALID') {
        setErrors((err.details as { errors: CsvError[] }).errors);
      } else setFlash({ tone: 'danger', text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    setBusy('submit');
    setFlash(null);
    try {
      await api(`/batches/${b.id}/submit`, { method: 'POST' });
      setFlash({ tone: 'success', text: 'Submitted for district review.' });
      onDone();
    } catch (err) {
      setFlash({ tone: 'danger', text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h2>Candidates CSV</h2>
      <form className="upload-row" onSubmit={upload}>
        <input key={inputKey} type="file" accept=".csv,text/csv" aria-label="Candidate CSV file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button className="btn btn-secondary" disabled={!file || busy !== null}>
          {busy === 'upload' ? 'Uploading…' : 'Upload CSV'}
        </button>
        <span className="muted small">
          Samples: <a href="/samples/valid-10.csv" download>valid-10</a> · <a href="/samples/valid-60.csv" download>valid-60</a> ·{' '}
          <a href="/samples/invalid.csv" download>invalid</a>
        </span>
      </form>
      <p className="muted small">Header: candidate_ref, full_name, phone, completion_date (YYYY-MM-DD). Max 500 rows, 1 MB.</p>

      {errors && (
        <div className="csv-errors">
          <Alert>
            The CSV has {errors.length} problem{errors.length === 1 ? '' : 's'}. Nothing was saved. Fix these rows and upload again.
          </Alert>
          <div className="table-wrap table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">Row</th>
                  <th>Field</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((e, i) => (
                  <tr key={i}>
                    <td className="num">{e.row}</td>
                    <td className="mono">{e.field}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="action-row">
        <button className="btn btn-primary" onClick={submit} disabled={busy !== null || b.candidates.length === 0}>
          {busy === 'submit' ? 'Submitting…' : b.status === 'RETURNED' ? 'Resubmit for review' : 'Submit for review'}
        </button>
        {b.candidates.length === 0 && <span className="muted small">Upload candidates before submitting.</span>}
      </div>
    </>
  );
}

function ReviewActions({ batch: b, onDone, setFlash }: { batch: Batch; onDone: () => void; setFlash: (f: Flash) => void }) {
  const [open, setOpen] = useState<'APPROVE' | 'RETURN' | 'REJECT' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const decide = async (e: FormEvent) => {
    e.preventDefault();
    if (!open) return;
    setBusy(true);
    setFlash(null);
    try {
      const res = await api<{ batch: { status: string } }>(`/batches/${b.id}/decisions`, { json: open === 'APPROVE' ? { type: open } : { type: open, reason: reason.trim() } });
      setFlash({ tone: 'success', text: `Recorded ${humanize(open)}. The status above updates live.` });
      onDone();
    } catch (err) {
      setFlash({ tone: 'danger', text: err instanceof ApiError ? `${err.code}: ${err.message}` : errorText(err) });
    } finally {
      setBusy(false);
      setOpen(null);
      setReason('');
    }
  };

  const close = () => {
    setOpen(null);
    setReason('');
  };

  return (
    <div className="card card-action">
      <h2>Your review</h2>
      <p className="muted small">
        {b.status === 'DISTRICT_REVIEW' ? 'Two different district officers must approve.' : 'One approval moves the batch to the next stage.'} Returning sends it back to the centre to
        fix; rejecting is final.
      </p>
      <div className="action-row">
        <button className="btn btn-primary" onClick={() => setOpen('APPROVE')}>
          Approve
        </button>
        <button className="btn btn-secondary" onClick={() => setOpen('RETURN')}>
          Return to centre
        </button>
        <button className="btn btn-danger" onClick={() => setOpen('REJECT')}>
          Reject
        </button>
      </div>
      {open && (
        <Modal title={open === 'APPROVE' ? 'Approve this batch?' : open === 'RETURN' ? 'Return to centre' : 'Reject batch'} onClose={close}>
          <form onSubmit={decide}>
            {open === 'APPROVE' ? (
              <p>
                You are approving <strong>{b.courseName}</strong> ({b.candidates.length} candidates) at the {humanize(STAGE_OF[b.status])} stage.
              </p>
            ) : (
              <label className="field">
                <span>Reason (required, at least 5 characters)</span>
                <textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} required />
              </label>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={close}>
                Cancel
              </button>
              <button className={`btn ${open === 'REJECT' ? 'btn-danger' : 'btn-primary'}`} disabled={busy || (open !== 'APPROVE' && reason.trim().length < 5)}>
                {busy ? 'Saving…' : open === 'APPROVE' ? 'Approve' : open === 'RETURN' ? 'Return batch' : 'Reject batch'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Certificates({
  certs,
  loading,
  error,
  user,
  onChange,
  setFlash,
}: {
  certs: CertificateRow[] | undefined;
  loading: boolean;
  error: Error | null;
  user: User;
  onChange: () => void;
  setFlash: (f: Flash) => void;
}) {
  const [revoking, setRevoking] = useState<CertificateRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const canDownload = user.role === 'STATE' || user.role === 'CENTRE';

  const download = async (no: string) => {
    setBusy(no);
    try {
      await downloadPdf(no);
    } catch (err) {
      setFlash({ tone: 'danger', text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (e: FormEvent) => {
    e.preventDefault();
    if (!revoking) return;
    setBusy(revoking.certificateNo);
    try {
      await api(`/certificates/${revoking.certificateNo}/revoke`, { json: { reason: reason.trim() } });
      setFlash({ tone: 'success', text: `Certificate ${revoking.certificateNo} revoked. Public verification now shows it as revoked.` });
      onChange();
    } catch (err) {
      setFlash({ tone: 'danger', text: errorText(err) });
    } finally {
      setBusy(null);
      setRevoking(null);
      setReason('');
    }
  };

  const sent = certs?.filter((c) => c.delivery?.status === 'SENT').length ?? 0;
  return (
    <div className="card">
      <h2>
        Certificates {certs ? `(${certs.length})` : ''}
        {certs && <span className="muted small heading-note">{sent} delivered on WhatsApp</span>}
      </h2>
      {error && <Alert>{errorText(error)}</Alert>}
      {loading && !certs ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Certificate no.</th>
                <th>Candidate</th>
                <th>Status</th>
                <th>WhatsApp delivery</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {certs?.map((c) => (
                <tr key={c.id}>
                  <td className="mono">
                    <a href={`/verify/${c.certificateNo}`} target="_blank" rel="noreferrer">
                      {c.certificateNo}
                    </a>
                  </td>
                  <td>{c.candidate.fullName}</td>
                  <td>
                    <Badge status={c.status} />
                  </td>
                  <td title={c.delivery?.lastError ?? undefined}>
                    {c.delivery ? (
                      <>
                        <Badge status={c.delivery.status} /> <span className="muted small">{c.delivery.attempts} attempt{c.delivery.attempts === 1 ? '' : 's'}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="cell-actions">
                    {canDownload && c.status === 'VALID' && (
                      <button className="btn btn-secondary btn-sm" onClick={() => download(c.certificateNo)} disabled={busy === c.certificateNo}>
                        {busy === c.certificateNo ? '…' : 'Download PDF'}
                      </button>
                    )}
                    {user.role === 'STATE' && c.status === 'VALID' && (
                      <button className="btn btn-danger btn-sm" onClick={() => setRevoking(c)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {revoking && (
        <Modal title={`Revoke ${revoking.certificateNo}`} onClose={() => setRevoking(null)}>
          <form onSubmit={revoke}>
            <p>
              Revoking the certificate of <strong>{revoking.candidate.fullName}</strong> takes effect immediately. The record is kept, never deleted.
            </p>
            <label className="field">
              <span>Reason (required, at least 5 characters)</span>
              <textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} required />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setRevoking(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" disabled={busy !== null || reason.trim().length < 5}>
                Revoke certificate
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
