import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import CardSwap, { Card, type CardSwapHandle } from '../components/CardSwap/CardSwap';
import GooeyNav from '../components/GooeyNav/GooeyNav';
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
  {
    claim: 'A bad spreadsheet saves nothing.',
    how: 'The CSV replaces the candidate list in one database transaction, or not at all. Every bad row is reported with its row number.',
    test: 'invalid CSV reports row-level errors and saves nothing',
    icon: 'M5 3h10l4 4v14H5z M15 3v4h4 M9 13l6 6 M15 13l-6 6',
  },
  {
    claim: 'Simultaneous approvals count once.',
    how: 'A row lock on the batch serialises decisions, and a unique (batch, stage, round, officer) constraint makes a double vote impossible.',
    test: 'concurrent approvals advance the batch exactly once',
    icon: 'M8 11V7a4 4 0 0 1 8 0v4 M5 11h14v10H5z M12 15v2',
  },
  {
    claim: 'One certificate and one message per candidate.',
    how: 'Jobs are idempotent and the database enforces one certificate per candidate. Each WhatsApp send carries an idempotency key, so a timeout never sends twice.',
    test: 'a timeout after the provider accepted does not send twice',
    icon: 'M4 6h16v12H4z M4 7l8 6 8-6',
  },
  {
    claim: 'Revoked means revoked, immediately.',
    how: 'Every verification reads the live record. Nothing is cached, and a revoked certificate’s PDF is never served (410).',
    test: 'revoked certificates fail verification immediately',
    icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M5.6 5.6l12.8 12.8',
  },
  {
    claim: 'Every decision is traceable.',
    how: 'An audit row is written in the same transaction as each change. A Postgres trigger rejects any UPDATE or DELETE on the log.',
    test: 'audit log rejects UPDATE and DELETE',
    icon: 'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h4',
  },
  {
    claim: 'Stuck batches escalate on their own.',
    how: 'A job runs every 30 seconds and escalates, exactly once, any batch waiting longer than the SLA in a review stage.',
    test: 'a stuck batch is escalated exactly once',
    icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 3',
  },
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

const NAV_ITEMS = [
  { label: 'Overview', href: '#overview' },
  { label: 'Problem', href: '#problem' },
  { label: 'How it works', href: '#how' },
  { label: 'Guarantees', href: '#guarantees' },
  { label: 'Architecture', href: '#architecture' },
];

const pinned = { current: { index: 0, until: 0 } };

/** Scroll spy: the nav pill follows the section being read (last section whose top passed the header). */
function useActiveSection() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (Date.now() < pinned.current.until) return setActive(pinned.current.index);
        let index = 0;
        NAV_ITEMS.forEach((item, i) => {
          const el = document.getElementById(item.href.slice(1));
          if (el && el.getBoundingClientRect().top <= 140) index = i;
        });
        setActive(index);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
  return Date.now() < pinned.current.until ? pinned.current.index : active;
}

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [certNo, setCertNo] = useState('');
  const [formatError, setFormatError] = useState(false);
  const activeSection = useActiveSection();
  const [, force] = useState(0);
  const setActiveSection = (i: number) => {
    pinned.current = { index: i, until: Date.now() + 900 }; // keep the clicked pill while the page scrolls there
    force((n) => n + 1);
  };
  const [stats, setStats] = useState<{ certificatesIssued: number; validCertificates: number } | null | 'error'>(null);

  useEffect(() => {
    fetch('/api/public/stats', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setStats)
      .catch(() => setStats('error'));
  }, []);

  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    const onResize = () => window.innerWidth > 900 && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [menuOpen]);

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
          <GooeyNav
            ariaLabel="Page sections"
            className="lp-gooey"
            items={NAV_ITEMS}
            activeIndex={activeSection}
            onChange={(i) => setActiveSection(i)}
            theme="light"
            size="sm"
            color="#1b3a7a"
            colors={['#1b3a7a', '#c2560c', '#2f5bb5']}
            particleCount={12}
            animationTime={550}
          />
          <Link to="/verify" className="lp-head-link">
            Verify
          </Link>
          {user ? (
            <Link to={user.role === 'STATE' ? '/state' : '/batches'} className="btn btn-primary lp-head-cta">
              Go to dashboard
            </Link>
          ) : (
            <Link to="/login" className="btn btn-primary lp-head-cta">
              Sign in
            </Link>
          )}
          <button
            type="button"
            className="lp-menu-btn"
            aria-expanded={menuOpen}
            aria-controls="lp-mobile-menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
            <span className="sr-only">{menuOpen ? 'Close menu' : 'Open menu'}</span>
          </button>
        </div>
        {/* Mobile menu (under 900px the GooeyNav is hidden and this replaces it). */}
        <nav id="lp-mobile-menu" className="lp-mobile-menu" data-open={menuOpen} aria-label="Site menu" hidden={!menuOpen}>
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <a href={item.href} onClick={() => setMenuOpen(false)}>
                  {item.label}
                </a>
              </li>
            ))}
            <li>
              <Link to="/verify" onClick={() => setMenuOpen(false)}>
                Verify a certificate
              </Link>
            </li>
          </ul>
        </nav>
      </header>

      <main id="main">
        <section className="lp-hero" id="overview" aria-labelledby="hero-title">
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

        <Guarantees />

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

        <PrivacySecurity />

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

/** Guarantees: a synced numbered list (all the content, keyboard and screen-reader friendly) + a React Bits CardSwap stack. */
function Guarantees() {
  const swap = useRef<CardSwapHandle>(null);
  const [front, setFront] = useState(0);
  const bring = (i: number) => {
    const steps = (i - front + GUARANTEES.length) % GUARANTEES.length;
    for (let k = 0; k < steps; k++) window.setTimeout(() => swap.current?.next(), k * 140);
  };
  return (
    <section id="guarantees" className="lp-section lp-guar" aria-labelledby="guarantees-title">
      <div className="lp-wrap lp-guar-grid">
        <div className="lp-guar-copy">
          <h2 id="guarantees-title" className="lp-h2">
            What we guarantee
          </h2>
          <p className="lp-intro">
            Six things that must never go wrong. Each one is enforced by the database or the job design, and each has an automated test that fails the
            build if it ever breaks.
          </p>
          <ol className="lp-guar-list">
            {GUARANTEES.map((g, i) => (
              <li key={g.claim}>
                <button type="button" className="lp-guar-item" aria-pressed={i === front} onClick={() => bring(i)}>
                  <span className="lp-guar-no">{String(i + 1).padStart(2, '0')}</span>
                  <span className="lp-guar-claim">{g.claim}</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="lp-guar-hint">Drag the front card, use the arrow keys, or pick a guarantee from the list.</p>
        </div>
        <div className="lp-guar-stage">
          <CardSwap
            ref={swap}
            theme="dark"
            width={440}
            height={300}
            cardDistance={46}
            verticalDistance={54}
            skewAmount={4}
            delay={5200}
            cardRadius={20}
            onChange={setFront}
            ariaLabel="Guarantees, one card at a time"
          >
            {GUARANTEES.map((g, i) => (
              <Card key={g.claim} className="lp-gcard">
                <div className="lp-gcard-top">
                  <span className="lp-gcard-no">{String(i + 1).padStart(2, '0')}</span>
                  <svg className="lp-gcard-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d={g.icon} />
                  </svg>
                </div>
                <h3 className="lp-gcard-claim">{g.claim}</h3>
                <p className="lp-gcard-how">
                  <span>How</span> {g.how}
                </p>
                <p className="lp-gcard-test">
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                  <span>
                    Proven by test <code>{g.test}</code>
                  </span>
                </p>
              </Card>
            ))}
          </CardSwap>
        </div>
      </div>
    </section>
  );
}

/** Privacy & security: four claims, each with its evidence (real fields, real link shape, real scope, real arithmetic). */
function PrivacySecurity() {
  return (
    <section id="privacy" className="lp-section lp-surface lp-sec" aria-labelledby="privacy-title">
      <div className="lp-wrap">
        <h2 id="privacy-title" className="lp-h2">
          Privacy and security
        </h2>
        <p className="lp-intro">
          Public by design where it has to be, private everywhere else. Each claim below shows its evidence, taken from how the API actually behaves.
        </p>
        <div className="lp-sec-grid">
          <article className="lp-sec-card lp-sec-wide">
            <div className="lp-sec-text">
              <h3>The public sees seven fields. Nothing else.</h3>
              <p>Anyone can check a certificate without signing in, so the response is deliberately minimal: status, number, name, course, centre and two dates.</p>
              <p className="lp-sec-never-label">Never returned</p>
              <ul className="lp-sec-never">
                <li>phone number</li>
                <li>candidate ref</li>
                <li>internal ids</li>
                <li>revoke reason</li>
                <li>the PDF</li>
              </ul>
            </div>
            <pre className="lp-sec-code" aria-label="Example verification response">
              <span className="c">{'// GET /api/public/verify/CF-7K2M9QX4TR'}</span>
              {`
{
  "status": "VALID",
  "certificateNo": "CF-7K2M9QX4TR",
  "candidateName": "Priya Goud",
  "courseName": "Retail Sales Associate",
  "centreName": "Pragati Skill Centre",
  "completionDate": "2026-02-02",
  "issuedAt": "2026-11-21T06:44:00Z"
}`}
            </pre>
          </article>

          <article className="lp-sec-card">
            <h3>Download links can’t be forged.</h3>
            <p className="lp-sec-url" aria-label="Anatomy of a candidate download link">
              <span>/api/certificates/</span>
              <span className="u-id">CF-7K2M9QX4TR</span>
              <span>/pdf?token=</span>
              <span className="u-sig">Hq3V…k9Qw</span>
            </p>
            <p>
              The token is an HMAC-SHA256 signature of the certificate number made with a server secret. Change one character and it is refused. Staff
              downloads need the state office or the owning centre, and a revoked certificate returns 410.
            </p>
          </article>

          <article className="lp-sec-card">
            <h3>You only see your own batches.</h3>
            <table className="lp-sec-scope">
              <caption className="sr-only">What each role can see</caption>
              <tbody>
                <tr>
                  <th scope="row">Training centre</th>
                  <td>its own centre</td>
                </tr>
                <tr>
                  <th scope="row">District officer</th>
                  <td>its own district</td>
                </tr>
                <tr>
                  <th scope="row">Quality team</th>
                  <td>batches in quality review</td>
                </tr>
                <tr>
                  <th scope="row">State office</th>
                  <td>everything</td>
                </tr>
              </tbody>
            </table>
            <p>Outside your scope a batch returns 404, so its existence isn’t revealed. Staff see candidate phone numbers masked as ******1234.</p>
          </article>

          <article className="lp-sec-card lp-sec-wide lp-sec-math">
            <div>
              <h3>Guessing a certificate number is hopeless.</h3>
              <p>Numbers are CF- plus 10 random Crockford base32 characters: 50 random bits. Public lookups are rate-limited to 60 a minute per address.</p>
            </div>
            <dl className="lp-sec-figures">
              <div>
                <dt>Possible numbers</dt>
                <dd>
                  2<sup>50</sup> <small>≈ 1.13 quadrillion</small>
                </dd>
              </div>
              <div>
                <dt>To try them all at 60 a minute</dt>
                <dd>
                  ~36M <small>years</small>
                </dd>
              </div>
            </dl>
          </article>
        </div>
      </div>
    </section>
  );
}
