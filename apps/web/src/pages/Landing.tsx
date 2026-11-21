import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../App';

const REPO_URL = 'https://github.com/NikhilMamilla/AlgoHire-Hackathon';

const PROBLEMS = [
  ['Spreadsheets over email', 'Candidate lists travel as attachments, get edited in transit, and nobody knows which copy is current.'],
  ['Approvals over WhatsApp', 'A thumbs-up in a group chat is the only record that a district officer signed off.'],
  ['Certificates typed by hand', 'Each one is retyped from the list, so names get misspelt and candidates wait weeks.'],
  ['Copies nobody can check', 'An edited PDF looks just like a real one, and employers have no way to tell.'],
];

const STEPS = [
  ['Upload & validate', 'The centre uploads its CSV. Every row is checked; one bad row saves nothing.'],
  ['District review', 'Two different district officers must approve.'],
  ['Quality review', 'Large batches (50+ candidates) get a quality check.'],
  ['State approval', 'The state office gives the final sign-off.'],
  ['Issued + WhatsApp', 'One certificate per candidate, sent by WhatsApp with a download link.'],
  ['Public verification', 'Anyone scans the QR code and sees the live status.'],
];

const GUARANTEES = [
  ['Bad spreadsheets save nothing', 'Atomic import with row-level errors: fix the rows and upload again.'],
  ['Simultaneous approvals count once', 'A row lock on the batch plus a unique (batch, stage, round, officer) constraint.'],
  ['Exactly one certificate per candidate', 'Database uniqueness on the candidate and idempotent, retry-safe jobs.'],
  ['Revoked means revoked, immediately', 'Verification reads the live record on every check; nothing is cached.'],
  ['Every decision traceable', 'Each change writes an audit row in the same transaction; the log is append-only.'],
  ['Stuck batches escalate automatically', 'An SLA job flags any batch that waits too long in a review stage.'],
];

const CERT_NO = /^CF-[0-9A-HJKMNP-TV-Z]{10}$/;

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [certNo, setCertNo] = useState('');
  const [formatError, setFormatError] = useState(false);
  const [stats, setStats] = useState<{ certificatesIssued: number; validCertificates: number } | null>(null);

  useEffect(() => {
    fetch('/api/public/stats', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const verify = (e: FormEvent) => {
    e.preventDefault();
    const no = certNo.trim().toUpperCase();
    if (!CERT_NO.test(no)) return setFormatError(true);
    navigate(`/verify/${no}`);
  };

  return (
    <div className="landing">
      <header className="landing-head">
        <div className="landing-wrap landing-head-row">
          <Link to="/" className="brand brand-dark">
            CertiFlow
          </Link>
          <nav className="landing-nav" aria-label="Site">
            <a href="#how">How it works</a>
            <Link to="/verify">Verify a certificate</Link>
            {user ? (
              <Link to={user.role === 'STATE' ? '/state' : '/batches'} className="btn btn-primary btn-sm">
                Go to dashboard
              </Link>
            ) : (
              <Link to="/login" className="btn btn-secondary btn-sm">
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main>
        <section className="landing-wrap hero">
          <h1>Certificates that reach candidates in days, and can’t be faked.</h1>
          <p className="hero-sub">
            CertiFlow takes a training centre’s spreadsheet through district, quality and state approval, issues one tamper-evident certificate per
            candidate, and lets anyone verify it in seconds.
          </p>
          <div className="hero-actions">
            <Link to="/login" className="btn btn-primary">
              Sign in to the demo
            </Link>
            <Link to="/verify" className="btn btn-secondary">
              Verify a certificate
            </Link>
          </div>
          <form className="hero-verify" onSubmit={verify}>
            <label htmlFor="hero-certno">Have a certificate number?</label>
            <div className="hero-verify-row">
              <input
                id="hero-certno"
                className="mono"
                placeholder="CF-XXXXXXXXXX"
                value={certNo}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setCertNo(e.target.value);
                  setFormatError(false);
                }}
                aria-invalid={formatError}
                aria-describedby={formatError ? 'hero-certno-err' : undefined}
              />
              <button className="btn btn-secondary" disabled={!certNo.trim()}>
                Check
              </button>
            </div>
            {formatError && (
              <p id="hero-certno-err" className="field-error">
                Certificate numbers look like CF-XXXXXXXXXX.
              </p>
            )}
          </form>
        </section>

        <section className="landing-band">
          <div className="landing-wrap">
            <h2>The problem today</h2>
            <div className="problem-grid">
              {PROBLEMS.map(([title, body]) => (
                <div key={title} className="problem">
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-wrap" id="how">
          <h2>How it works</h2>
          <ol className="flow">
            {STEPS.map(([title, body], i) => (
              <li key={title} className="flow-step">
                <span className="flow-dot" aria-hidden="true">
                  {i + 1}
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-band">
          <div className="landing-wrap">
            <h2>What we guarantee</h2>
            <dl className="guarantees">
              {GUARANTEES.map(([claim, how]) => (
                <div key={claim} className="guarantee">
                  <dt>{claim}</dt>
                  <dd>{how}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="landing-wrap">
          <h2>Architecture</h2>
          <ArchitectureDiagram />
          <p className="muted small arch-caption">
            What is real vs simulated: WhatsApp delivery and demo sign-in are simulated; everything else runs for real.
          </p>
        </section>

        {stats && (
          <section className="landing-band">
            <div className="landing-wrap registry">
              <h2>Live registry</h2>
              <dl className="registry-figures">
                <div>
                  <dt>Certificates issued</dt>
                  <dd>{stats.certificatesIssued.toLocaleString('en-IN')}</dd>
                </div>
                <div>
                  <dt>Currently valid and verifiable</dt>
                  <dd>{stats.validCertificates.toLocaleString('en-IN')}</dd>
                </div>
              </dl>
              <p className="muted small">Counted from the database when this page loaded, in this demo environment.</p>
            </div>
          </section>
        )}
      </main>

      <footer className="landing-foot">
        <div className="landing-wrap">
          Built for the Algohire hackathon · Pragati Skills Mission is fictional ·{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

/** Browser → nginx → API → Postgres; API ↔ Redis ↔ Worker. Plain SVG, themed from CSS variables. */
function ArchitectureDiagram() {
  const box = (x: number, y: number, w: number, title: string, sub: string, strong = false) => (
    <g>
      <rect x={x} y={y} width={w} height={56} rx={6} className={strong ? 'arch-box arch-box-strong' : 'arch-box'} />
      <text x={x + w / 2} y={y + 24} textAnchor="middle" className="arch-title">
        {title}
      </text>
      <text x={x + w / 2} y={y + 42} textAnchor="middle" className="arch-sub">
        {sub}
      </text>
    </g>
  );
  const arrow = (x1: number, y1: number, x2: number, y2: number, both = false) => (
    <line x1={x1} y1={y1} x2={x2} y2={y2} className="arch-line" markerEnd="url(#arrow)" markerStart={both ? 'url(#arrow)' : undefined} />
  );
  return (
    <svg className="arch" viewBox="0 0 880 210" role="img" aria-label="Browser to nginx to API to Postgres; the API and the worker share Redis for queues and live events">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="arch-arrow" />
        </marker>
      </defs>
      {box(10, 20, 150, 'Browser', 'React app, SSE')}
      {box(230, 20, 150, 'nginx', 'static + /api proxy')}
      {box(450, 20, 180, 'API', 'Express, auth, workflow', true)}
      {box(700, 20, 170, 'PostgreSQL', 'data, audit log')}
      {box(450, 134, 180, 'Redis', 'queues, pub/sub')}
      {box(700, 134, 170, 'Worker', 'certificates, WhatsApp sim, SLA')}
      {arrow(160, 48, 228, 48)}
      {arrow(380, 48, 448, 48)}
      {arrow(630, 48, 698, 48)}
      {arrow(540, 76, 540, 132, true)}
      {arrow(632, 162, 698, 162, true)}
      <line x1={785} y1={134} x2={785} y2={78} className="arch-line arch-line-dashed" markerEnd="url(#arrow)" />
    </svg>
  );
}
