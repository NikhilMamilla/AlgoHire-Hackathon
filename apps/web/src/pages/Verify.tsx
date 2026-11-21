import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon, Mark, fmtDate, fmtDateTime } from '../components';

const CERT_NO = /^CF-[0-9A-HJKMNP-TV-Z]{10}$/;

type Found = {
  status: 'VALID' | 'REVOKED';
  certificateNo: string;
  candidateName: string;
  courseName: string;
  centreName: string;
  completionDate: string;
  issuedAt: string;
  revokedAt?: string;
};
type Result = { kind: 'found'; data: Found; checkedAt: Date } | { kind: 'invalid'; certNo: string } | { kind: 'error'; message: string } | null;

/** Public page (the QR code lands here). No login, and always fresh from the API. */
export default function Verify() {
  const { certNo: param } = useParams<{ certNo?: string }>();
  const navigate = useNavigate();
  const [input, setInput] = useState(param ?? '');
  const [result, setResult] = useState<Result>(null);
  const [loading, setLoading] = useState(false);

  const lookup = useCallback(async (raw: string) => {
    const no = raw.trim().toUpperCase();
    if (!CERT_NO.test(no)) {
      setResult({ kind: 'error', message: 'That does not look like a certificate number. It has the form CF-XXXXXXXXXX.' });
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`/api/public/verify/${encodeURIComponent(no)}`, { cache: 'no-store' });
      if (res.status === 404) setResult({ kind: 'invalid', certNo: no });
      else if (res.status === 429) setResult({ kind: 'error', message: 'Too many checks from your network. Please wait a minute and try again.' });
      else if (!res.ok) setResult({ kind: 'error', message: 'That does not look like a certificate number. It has the form CF-XXXXXXXXXX.' });
      else setResult({ kind: 'found', data: (await res.json()) as Found, checkedAt: new Date() });
    } catch {
      setResult({ kind: 'error', message: 'Could not reach the verification service. Check your connection and try again.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (param) {
      setInput(param);
      void lookup(param);
    }
  }, [param, lookup]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const no = input.trim().toUpperCase();
    if (no === (param ?? '').toUpperCase()) void lookup(no);
    else navigate(`/verify/${encodeURIComponent(no)}`);
  };

  return (
    <div className="public">
      <header className="public-head">
        <Link to="/" className="brand brand-dark">
          <Mark size={24} />
          CertiFlow
        </Link>
        <span className="muted public-head-note">Certificate verification · Pragati Skills Mission</span>
      </header>
      <main className="public-main" id="main" tabIndex={-1}>
        <h1>Verify a certificate</h1>
        <p className="muted">Enter the certificate number printed on the certificate, or scan its QR code.</p>
        <form className="verify-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="certno">
            Certificate number
          </label>
          <input
            id="certno"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="CF-XXXXXXXXXX"
            autoComplete="off"
            spellCheck={false}
            className="mono"
          />
          <button className="btn btn-primary" disabled={loading || !input.trim()}>
            {loading ? 'Checking…' : 'Verify'}
          </button>
        </form>

        {loading && (
          <div className="result result-loading" role="status">
            Checking…
          </div>
        )}
        {result?.kind === 'found' && (
          <Record
            d={result.data}
            checkedAt={result.checkedAt}
            valid={result.data.status === 'VALID'}
            title={result.data.status === 'VALID' ? 'Valid certificate' : 'This certificate has been revoked and is not valid'}
            subtitle={
              result.data.status === 'VALID' ? 'Issued by Pragati Skills Mission' : `Revoked on ${fmtDate(result.data.revokedAt)}. Do not accept it as proof of completion.`
            }
          />
        )}
        {result?.kind === 'invalid' && (
          <div className="result result-invalid" role="alert">
            <div className="result-title">No certificate with this number</div>
            <p className="mono">{result.certNo}</p>
            <p className="muted">Check the number for typos. Genuine certificates always verify here.</p>
          </div>
        )}
        {result?.kind === 'error' && (
          <div className="result result-invalid" role="alert">
            {result.message}
          </div>
        )}
      </main>
      <footer className="public-foot muted small">Pragati Skills Mission · verification reads the live registry on every check.</footer>
    </div>
  );
}


function Record({ d, valid, title, subtitle, checkedAt }: { d: Found; valid: boolean; title: string; subtitle: string; checkedAt: Date }) {
  return (
    <article className={`result ${valid ? 'result-valid' : 'result-revoked'}`} role={valid ? 'status' : 'alert'}>
      <header className="result-band">
        <span className="result-icon" aria-hidden="true">
          <Icon name={valid ? 'check' : 'cross'} size={22} />
        </span>
        <div>
          <div className="result-title">{title}</div>
          <div className="result-sub">{subtitle}</div>
        </div>
      </header>
      <div className="result-body">
        <p className="result-name">{d.candidateName}</p>
        <p className="result-course">
          completed <strong>{d.courseName}</strong> at {d.centreName}
        </p>
        <Details d={d} />
      </div>
      <footer className="result-foot">Checked against the live registry · {fmtDateTime(checkedAt.toISOString())}</footer>
    </article>
  );
}

function Details({ d }: { d: Found }) {
  return (
    <dl className="details">
      <dt>Completed</dt>
      <dd>{fmtDate(d.completionDate)}</dd>
      <dt>Issued</dt>
      <dd>{fmtDate(d.issuedAt)}</dd>
      <dt>Certificate no.</dt>
      <dd>
        <span className="mono">{d.certificateNo}</span>
        <CopyButton text={d.certificateNo} />
      </dd>
    </dl>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (e.g. insecure context): the number stays selectable */
    }
  };
  return (
    <button type="button" className="btn btn-secondary btn-sm copy-btn" onClick={copy} aria-label={copied ? 'Copied' : `Copy certificate number ${text}`}>
      <Icon name="copy" size={14} />
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
