import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../App';

const REPO = 'https://github.com/NikhilMamilla/AlgoHire-Hackathon';
const CERT_NO = /^CF-[0-9A-HJKMNP-TV-Z]{10}$/;

/* Inline icons: 24px grid, 1.75 stroke, decorative only (aria-hidden). */
const Icon = ({ d }: { d: string }) => (
  <svg className="lp-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d={d} />
  </svg>
);
const ICONS = {
  sheet: 'M5 3h10l4 4v14H5z M15 3v4h4 M8 12h8 M8 16h8 M12 9v11',
  chat: 'M4 5h16v11H9l-5 4z M8 9h8 M8 12h5',
  type: 'M6 4h12 M12 4v16 M9 20h6',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z M9 12l2 2 4-4',
};

const PROBLEMS: { icon: keyof typeof ICONS; title: string; body: string }[] = [
  {
    icon: 'sheet',
    title: 'Spreadsheets over email',
    body: 'Centres email candidate lists as attachments that get edited along the way. Nobody can say which copy is current, and errors surface only after certificates are printed.',
  },
  {
    icon: 'chat',
    title: 'Approvals over WhatsApp',
    body: 'A thumbs-up in a group chat is the only sign that an officer approved a batch. There is no record of who decided what, or when.',
  },
  {
    icon: 'type',
    title: 'Certificates typed in Word',
    body: 'Each certificate is retyped by hand from the list, so names get misspelt. Candidates wait weeks for a document they need for a job.',
  },
  {
    icon: 'shield',
    title: 'Copies nobody can check',
    body: 'An edited PDF looks exactly like a real one. Employers have no quick way to tell, so genuine certificates lose their value.',
  },
];

const ROLES = [
  ['Training centre', 'Creates a batch, uploads the candidate spreadsheet, fixes row errors and submits it for review.', 'Anika'],
  ['District officers', 'Review batches from their own district. Two different officers must approve before a batch moves on.', 'Dev, Meera, Kabir'],
  ['Quality team', 'Checks large batches of 50 or more candidates before they reach the state office.', 'Neha'],
  ['State office', 'Gives the final approval, revokes certificates, watches escalations and re-sends failed messages.', 'Farah'],
  ['Candidates', 'Receive a WhatsApp message with a signed download link and a verification link. They never need an account.', 'via WhatsApp'],
  ['Employers and public', 'Scan the QR code or type the certificate number to see its live status. No sign-in.', 'no login'],
];

const STEPS = [
  ['Upload & validate', 'The centre uploads a CSV. Every row is checked and every error is listed with its row number; if any row is wrong, nothing is saved, so a batch is never half-imported.'],
  ['District review', 'Two different district officers from the batch’s own district must approve. The same officer approving twice counts once.'],
  ['Quality review', 'Batches of 50 or more candidates go to the quality team first. Smaller batches go straight to the state office.'],
  ['State approval', 'The state office has the final say. Approval is recorded, and the officer’s screen never waits for the work that follows.'],
  ['Certificates issued', 'A background worker creates one certificate per candidate, each with a unique number and a QR code on its PDF, in a single transaction.'],
  ['WhatsApp delivery', 'Each candidate gets one message. Failed sends are retried up to 6 times with growing delays, and a retry never sends a second copy.'],
  ['Anyone verifies', 'Scanning the QR code shows the live status from the database. Revocation takes effect on the very next check.'],
];

const GUARANTEES = [
  ['A bad spreadsheet saves nothing.', 'Atomic transaction: the CSV replaces the candidate list in one go, or not at all, with row-level errors.'],
  ['Simultaneous approvals count once.', 'Row lock on the batch plus a unique (batch, stage, round, officer) constraint in Postgres.'],
  ['One certificate and one message per candidate.', 'Idempotent jobs plus database constraints; the WhatsApp send carries an idempotency key, so a timeout can’t cause a duplicate.'],
  ['Revoked means revoked, immediately.', 'Live status lookup on every verification; nothing is cached, and a revoked PDF is never served.'],
  ['Every decision is traceable.', 'Append-only audit log written in the same transaction as the change; a database trigger rejects edits and deletes.'],
  ['Stuck batches escalate on their own.', 'SLA job every 30 seconds flags a batch that waits too long in a review stage.'],
];

const PRIVACY = [
  ['Minimal public data', 'Verification shows only status, name, course, centre and dates. No phone numbers, internal ids or the PDF itself.'],
  ['Signed download links', 'The PDF link sent to a candidate carries an HMAC signature; staff downloads require the state office or the owning centre.'],
  ['Server-side scoping', 'Every request is checked for role and district on the server. A batch outside your scope simply does not exist for you.'],
  ['Unguessable, rate-limited lookups', 'Certificate numbers carry 50 random bits, and public endpoints are limited per IP to stop bulk scanning.'],
];

function Mark() {
  return (
    <svg className="lp-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="8" className="lp-mark-bg" />
      <path d="M10 16.5l4 4 8-9" className="lp-mark-check" />
    </svg>
  );
}

function Section({ id, title, intro, tone = 'surface', children }: { id: string; title: string; intro?: string; tone?: 'surface' | 'bg'; children: ReactNode }) {
  return (
    <section id={id} className={`lp-section lp-${tone}`} aria-labelledby={`${id}-title`}>
      <div className="lp-wrap">
        <h2 id={`${id}-title`} className="lp-h2">
          {title}
        </h2>
        {intro && <p className="lp-intro">{intro}</p>}
        {children}
      </div>
    </section>
  );
}

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [certNo, setCertNo] = useState('');
  const [formatError, setFormatError] = useState(false);
  const [stats, setStats] = useState<{ certificatesIssued: number; validCertificates: number } | null | 'error'>(null);

  useEffect(() => {
    fetch('/api/public/stats', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setStats)
      .catch(() => setStats('error'));
  }, []);

  const verify = (e: FormEvent) => {
    e.preventDefault();
    const no = certNo.trim().toUpperCase();
    if (!CERT_NO.test(no)) return setFormatError(true);
    navigate(`/verify/${no}`);
  };

  return (
    <div className="lp">
      <header className="lp-head">
        <div className="lp-wrap lp-head-row">
          <Link to="/" className="lp-brand" aria-label="CertiFlow home">
            <Mark />
            <span>CertiFlow</span>
          </Link>
          <nav className="lp-nav" aria-label="Page sections">
            <a href="#problem">Problem</a>
            <a href="#how">How it works</a>
            <a href="#guarantees">Guarantees</a>
            <a href="#architecture">Architecture</a>
            <Link to="/verify">Verify</Link>
          </nav>
          {user ? (
            <Link to={user.role === 'STATE' ? '/state' : '/batches'} className="btn btn-primary lp-head-cta">
              Go to dashboard
            </Link>
          ) : (
            <Link to="/login" className="btn btn-primary lp-head-cta">
              Sign in
            </Link>
          )}
        </div>
      </header>

      <main id="main">
        <section className="lp-hero" aria-labelledby="hero-title">
          <div className="lp-wrap lp-hero-grid">
            <div className="lp-hero-copy">
              <p className="lp-eyebrow">Pragati Skills Mission · fictional state programme</p>
              <h1 id="hero-title">
                Certificates that reach candidates in days, and <span className="lp-underline">can’t be faked</span>.
              </h1>
              <p className="lp-lead">
                CertiFlow takes a training centre’s spreadsheet through district, quality and state approval, issues one tamper-evident certificate per
                candidate, and lets anyone verify it in seconds.
              </p>
              <div className="lp-ctas">
                <Link to="/login" className="btn btn-primary lp-btn-lg">
                  Sign in to the demo
                </Link>
                <Link to="/verify" className="btn btn-secondary lp-btn-lg">
                  Verify a certificate
                </Link>
              </div>
              <form className="lp-verify" onSubmit={verify} noValidate>
                <label htmlFor="lp-certno">Have a certificate number?</label>
                <div className="lp-verify-row">
                  <input
                    id="lp-certno"
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
                    aria-describedby={formatError ? 'lp-certno-err' : undefined}
                  />
                  <button className="btn btn-secondary" disabled={!certNo.trim()} title={certNo.trim() ? undefined : 'Type a certificate number first'}>
                    Check
                  </button>
                </div>
                {formatError && (
                  <p id="lp-certno-err" className="lp-field-error" role="alert">
                    Certificate numbers look like CF- followed by 10 letters and digits.
                  </p>
                )}
              </form>
            </div>

            <figure className="lp-example" aria-label="Example of a verification result">
              <span className="lp-example-tag">Example</span>
              <div className="lp-example-card">
                <div className="lp-example-band">
                  <svg viewBox="0 0 24 24" className="lp-example-icon" aria-hidden="true" focusable="false">
                    <circle cx="12" cy="12" r="11" />
                    <path d="M7 12.5l3.2 3.2L17 9" />
                  </svg>
                  <div>
                    <div className="lp-example-status">Valid certificate</div>
                    <div className="lp-example-sub">Issued by Pragati Skills Mission</div>
                  </div>
                </div>
                <div className="lp-example-body">
                  <p className="lp-example-name">Priya Goud</p>
                  <p className="lp-example-course">
                    completed <strong>Retail Sales Associate</strong> at Pragati Skill Centre, Kukatpally
                  </p>
                  <dl className="lp-example-dl">
                    <dt>Completed</dt>
                    <dd>2 Feb 2026</dd>
                    <dt>Certificate no.</dt>
                    <dd className="mono">CF-7K2M9QX4TR</dd>
                  </dl>
                </div>
                <div className="lp-example-foot">Checked against the live registry</div>
              </div>
              <figcaption className="lp-example-caption">Illustration only, not a real certificate.</figcaption>
            </figure>
          </div>

          <div className="lp-wrap">
            <div className="lp-facts" aria-label="From the programme brief">
              <span className="lp-facts-label">From the programme brief</span>
              <ul>
                <li>
                  <strong>~8,000</strong> candidates trained a month
                </li>
                <li>
                  <strong>300+</strong> private training centres
                </li>
                <li>
                  <strong>weeks → days</strong> to certify
                </li>
              </ul>
            </div>
          </div>
        </section>

        <Section
          id="problem"
          title="The problem today"
          tone="bg"
          intro="Skilling certificates move through email, chat and Word documents. Every hand-off loses information, and the end result can’t be trusted."
        >
          <div className="lp-problems">
            {PROBLEMS.map((p) => (
              <article key={p.title} className="lp-card">
                <Icon d={ICONS[p.icon]} />
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>
          <blockquote className="lp-quote">
            <p>“Files sitting with an officer for days is our biggest complaint.”</p>
            <footer>Programme brief</footer>
          </blockquote>
        </Section>

        <Section id="who" title="Who uses it" intro="Four staff roles work inside CertiFlow. Candidates and employers never need an account.">
          <ul className="lp-roles">
            {ROLES.map(([role, what, who]) => (
              <li key={role} className="lp-role">
                <h3>{role}</h3>
                <p>{what}</p>
                <span className="lp-role-who">Demo: {who}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="how" title="How it works" tone="bg" intro="Seven steps from spreadsheet to verified certificate. Every step is recorded, and every screen updates live.">
          <div className="lp-how">
            <ol className="lp-timeline">
              {STEPS.map(([title, body], i) => (
                <li key={title} className="flow-step">
                  <span className="lp-step-no" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <aside className="lp-notes" aria-label="Exceptions">
              <div className="lp-note">
                <h3>Return or reject</h3>
                <p>
                  Any reviewer can return a batch to the centre or reject it; both need a written reason. A returned batch is fixed and resubmitted as a new round,
                  and approvals from the earlier round no longer count. Rejection is final.
                </p>
              </div>
              <div className="lp-note">
                <h3>Escalation</h3>
                <p>
                  A batch that waits longer than the SLA in a review stage (2 minutes in this demo) is escalated once and shows up on the state office dashboard.
                </p>
              </div>
            </aside>
          </div>
        </Section>

        <Section id="guarantees" title="What we guarantee" intro="These are the things that must never go wrong. Each is enforced by the database or the job design, not by hoping the UI is used correctly.">
          <ul className="lp-guarantees">
            {GUARANTEES.map(([claim, how]) => (
              <li key={claim} className="lp-card lp-guarantee">
                <strong>{claim}</strong>
                <p>
                  <span className="lp-how-label">How:</span> {how}
                </p>
                <span className="lp-tested">
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                  Proven by automated tests
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="architecture" title="Architecture" tone="bg" intro="Five containers, one codebase. The API and the worker share one image and talk through Redis.">
          <div className="lp-arch">
            <ArchitectureDiagram />
            <div className="lp-arch-side">
              <h3>Why these choices</h3>
              <ul className="lp-why">
                <li>
                  <strong>PostgreSQL</strong> holds correctness in constraints and transactions, so the rules hold even if application code has a bug.
                </li>
                <li>
                  <strong>Redis + BullMQ</strong> gives durable jobs, retries with backoff and recovery after a worker crash, without adding another system.
                </li>
                <li>
                  <strong>Server-Sent Events</strong> are the simplest way to push one-way live updates through nginx.
                </li>
              </ul>
              <div className="lp-real">
                <h3>Real vs simulated</h3>
                <dl>
                  <dt>Simulated</dt>
                  <dd>The WhatsApp provider and the one-click demo sign-in.</dd>
                  <dt>Real</dt>
                  <dd>Everything else: database, queues, workers, PDFs, verification, audit.</dd>
                  <dt>Not deployed</dt>
                  <dd>
                    Runs locally with Docker Compose; see{' '}
                    <a href={`${REPO}/blob/main/DEPLOYMENT.md`} target="_blank" rel="noreferrer">
                      DEPLOYMENT.md
                    </a>
                    .
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </Section>

        <Section id="privacy" title="Privacy and security">
          <ul className="lp-privacy">
            {PRIVACY.map(([title, body]) => (
              <li key={title}>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ul>
        </Section>

        {stats !== 'error' && (
          <Section id="registry" title="Live registry" tone="bg">
            <dl className="lp-registry" aria-busy={stats === null}>
              <div>
                <dt>Certificates issued</dt>
                <dd>{stats ? stats.certificatesIssued.toLocaleString('en-IN') : <span className="lp-skel" />}</dd>
              </div>
              <div>
                <dt>Currently valid and verifiable</dt>
                <dd>{stats ? stats.validCertificates.toLocaleString('en-IN') : <span className="lp-skel" />}</dd>
              </div>
            </dl>
            <p className="lp-small">Counted from this demo’s database when the page loaded, and updated live as batches are issued.</p>
          </Section>
        )}

        <section className="lp-cta" aria-labelledby="try-title">
          <div className="lp-wrap lp-cta-grid">
            <div>
              <h2 id="try-title" className="lp-h2">
                Try it
              </h2>
              <p>Every role is one click away, and every permission is still enforced by the server. The demo has its own database, so try anything.</p>
              <div className="lp-ctas">
                <Link to="/login" className="btn lp-btn-inverse lp-btn-lg">
                  Sign in as any role
                </Link>
                <Link to="/verify" className="btn lp-btn-ghost-inverse lp-btn-lg">
                  Verify a certificate
                </Link>
              </div>
            </div>
            <ol className="lp-path" aria-label="Suggested demo path">
              <li>
                <strong>As Anika</strong>, create a batch, upload <span className="mono">invalid.csv</span> to see row errors, then <span className="mono">valid-10.csv</span>{' '}
                and submit.
              </li>
              <li>
                <strong>As Dev, then Meera</strong>, approve it (watch the list update live), then <strong>as Farah</strong> give final approval.
              </li>
              <li>
                <strong>Open a certificate number</strong> to verify it, then revoke it as Farah and check again.
              </li>
            </ol>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-row">
          <span className="lp-brand lp-brand-sm">
            <Mark />
            <span>CertiFlow</span>
          </span>
          <span>Built for the Algohire hackathon · Pragati Skills Mission is fictional</span>
          <nav aria-label="Project links" className="lp-foot-links">
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={`${REPO}/blob/main/README.md`} target="_blank" rel="noreferrer">
              README
            </a>
            <a href={`${REPO}/blob/main/SETUP.md`} target="_blank" rel="noreferrer">
              SETUP
            </a>
            <a href={`${REPO}/blob/main/DEPLOYMENT.md`} target="_blank" rel="noreferrer">
              DEPLOYMENT
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** Browser → nginx → API → PostgreSQL; API ⇄ Redis ⇄ Worker; SSE back to the browser. Styled from CSS tokens. */
function ArchitectureDiagram() {
  const box = (x: number, y: number, w: number, title: string, sub: string, strong = false) => (
    <g>
      <rect x={x} y={y} width={w} height={64} rx={10} className={strong ? 'arch-box arch-box-strong' : 'arch-box'} />
      <text x={x + w / 2} y={y + 28} textAnchor="middle" className="arch-title">
        {title}
      </text>
      <text x={x + w / 2} y={y + 47} textAnchor="middle" className="arch-sub">
        {sub}
      </text>
    </g>
  );
  const label = (x: number, y: number, text: string) => (
    <text x={x} y={y} textAnchor="middle" className="arch-label">
      {text}
    </text>
  );
  return (
    <svg
      className="lp-arch-svg"
      viewBox="0 0 720 330"
      role="img"
      aria-label="Browser connects through nginx to the Express API, which uses PostgreSQL. The API and the worker share Redis for BullMQ queues and pub/sub; the worker issues certificates, simulates WhatsApp and runs the SLA and reconciler jobs. Live updates return to the browser over Server-Sent Events."
    >
      <defs>
        <marker id="lp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="arch-arrow" />
        </marker>
      </defs>
      {box(10, 20, 150, 'Browser', 'React app')}
      {box(200, 20, 150, 'nginx', 'static + /api proxy')}
      {box(390, 20, 150, 'API', 'Express · auth · workflow', true)}
      {box(580, 20, 130, 'PostgreSQL', 'data · audit log')}
      {box(390, 170, 150, 'Redis', 'BullMQ · pub/sub')}
      {box(560, 170, 150, 'Worker', 'issuance · WhatsApp sim')}

      <line x1={160} y1={52} x2={198} y2={52} className="arch-line" markerEnd="url(#lp-arrow)" />
      <line x1={350} y1={52} x2={388} y2={52} className="arch-line" markerEnd="url(#lp-arrow)" />
      <line x1={540} y1={52} x2={578} y2={52} className="arch-line" markerEnd="url(#lp-arrow)" />
      {label(560, 44, 'SQL')}

      <line x1={465} y1={84} x2={465} y2={168} className="arch-line" markerEnd="url(#lp-arrow)" markerStart="url(#lp-arrow)" />
      {label(500, 132, 'jobs')}
      {label(500, 146, 'events')}

      <line x1={540} y1={202} x2={558} y2={202} className="arch-line" markerEnd="url(#lp-arrow)" markerStart="url(#lp-arrow)" />

      <line x1={645} y1={168} x2={645} y2={86} className="arch-line arch-line-dashed" markerEnd="url(#lp-arrow)" />
      {label(678, 132, 'tx')}

      <path d="M 410 86 C 380 310, 110 310, 85 88" className="arch-line arch-line-sse" markerEnd="url(#lp-arrow)" />
      {label(245, 292, 'SSE · live updates')}

      <text x={635} y={262} textAnchor="middle" className="arch-sub">
        SLA + reconciler every 30s
      </text>
    </svg>
  );
}
