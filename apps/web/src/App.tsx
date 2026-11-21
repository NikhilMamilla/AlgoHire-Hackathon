import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, session, type User } from './api';
import { Icon, Mark, ROLE_LABEL } from './components';
import BatchDetail from './pages/BatchDetail';
import Batches from './pages/Batches';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Outbox from './pages/Outbox';
import StateDashboard from './pages/StateDashboard';
import Verify from './pages/Verify';

type AuthCtx = { user: User | null; signIn: (token: string, user: User) => void; signOut: () => void };
const Auth = createContext<AuthCtx>({ user: null, signIn: () => {}, signOut: () => {} });
export const useAuth = () => useContext(Auth);

export default function App() {
  const [user, setUser] = useState<User | null>(() => (session.token() ? session.user() : null));

  const signIn = useCallback((token: string, u: User) => {
    session.set(token, u);
    setUser(u);
  }, []);
  const signOut = useCallback(() => {
    session.clear();
    setUser(null);
  }, []);

  // Re-validate the stored token once; the server is the source of truth for the role.
  useEffect(() => {
    if (!session.token()) return;
    api<{ user: User }>('/me')
      .then(({ user: fresh }) => {
        const merged = { ...fresh, org: session.user()?.org };
        session.saveUser(merged);
        setUser(merged);
      })
      .catch(() => {});
  }, []);

  return (
    <Auth.Provider value={{ user, signIn, signOut }}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <TitleSync />
      <Routes>
        <Route path="/verify" element={<Verify />} />
        <Route path="/verify/:certNo" element={<Verify />} />
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Landing />} />
        <Route element={<Shell />}>
          <Route path="/batches" element={<Batches />} />
          <Route path="/batches/:id" element={<BatchDetail />} />
          <Route path="/state" element={<StateOnly><StateDashboard /></StateOnly>} />
          <Route path="/whatsapp" element={<StateOnly><Outbox /></StateOnly>} />
          <Route path="*" element={<p className="muted">Page not found.</p>} />
        </Route>
      </Routes>
    </Auth.Provider>
  );
}

function StateOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // Client-side guard only for navigation; the API enforces STATE on every call.
  return user?.role === 'STATE' ? <>{children}</> : <p className="muted">This page is for the state office.</p>;
}

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'CertiFlow · Skilling certificates anyone can verify'],
  [/^\/login$/, 'Sign in · CertiFlow'],
  [/^\/verify/, 'Verify a certificate · CertiFlow'],
  [/^\/batches\/[^/]+$/, 'Batch · CertiFlow'],
  [/^\/batches$/, 'Batches · CertiFlow'],
  [/^\/state$/, 'State overview · CertiFlow'],
  [/^\/whatsapp$/, 'WhatsApp outbox · CertiFlow'],
];

/** One <title> per route. */
function TitleSync() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = TITLES.find(([re]) => re.test(pathname))?.[1] ?? 'CertiFlow';
  }, [pathname]);
  return null;
}

function crumbsFor(pathname: string): { label: string; to?: string }[] {
  if (pathname.startsWith('/batches/')) return [{ label: 'Batches', to: '/batches' }, { label: 'Batch' }];
  if (pathname === '/state') return [{ label: 'State overview' }];
  if (pathname === '/whatsapp') return [{ label: 'State office', to: '/state' }, { label: 'WhatsApp outbox' }];
  return [{ label: 'Batches' }];
}

function Shell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  if (!user || !session.token()) return <Navigate to="/login" replace />;

  const switchUser = () => {
    signOut();
    navigate('/login');
  };
  const logOut = () => {
    signOut();
    navigate('/', { replace: true });
  };
  const crumbs = crumbsFor(pathname);

  return (
    <div className={`shell ${menuOpen ? 'shell-menu-open' : ''}`}>
      <aside className="sidebar" id="app-sidebar" aria-label="Sidebar">
        <Link to="/" className="brand">
          <Mark size={26} />
          CertiFlow
        </Link>
        <nav aria-label="Main">
          <div className="nav-section">Workspace</div>
          <NavLink to="/batches" className="nav-link">
            Batches
          </NavLink>
          {user.role === 'STATE' && (
            <>
              <div className="nav-section">State office</div>
              <NavLink to="/state" className="nav-link">
                State overview
              </NavLink>
              <NavLink to="/whatsapp" className="nav-link">
                WhatsApp outbox
              </NavLink>
            </>
          )}
          <div className="nav-section">Public</div>
          <a href="/verify" target="_blank" rel="noreferrer" className="nav-link">
            Verify a certificate
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </nav>
        <div className="sidebar-user">
          <span className={`avatar avatar-${user.role.toLowerCase()}`} aria-hidden="true">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="user-chip">
            <strong>{user.name}</strong>
            <span className="muted" title={`${ROLE_LABEL[user.role]}${user.org ? ` · ${user.org}` : ''}`}>
              {ROLE_LABEL[user.role]}
              {user.org ? ` · ${user.org}` : ''}
            </span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={switchUser}>
            Switch user
          </button>
        </div>
      </aside>
      <header className="topbar">
        <button
          className="btn btn-ghost btn-sm menu-button"
          aria-expanded={menuOpen}
          aria-controls="app-sidebar"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <Icon name="menu" />
          <span className="sr-only">Menu</span>
        </button>
        <Link to="/" className="brand brand-mobile">
          <Mark size={22} />
          CertiFlow
        </Link>
        <nav className="crumbs" aria-label="Breadcrumb">
          <ol>
            {crumbs.map((c, i) => (
              <li key={c.label}>
                {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>}
              </li>
            ))}
          </ol>
        </nav>
        <div className="topbar-actions">
          <span className="topbar-who">
            <span className={`avatar avatar-${user.role.toLowerCase()}`} aria-hidden="true">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="topbar-name">{user.name}</span>
          </span>
          <button className="btn btn-secondary btn-sm" onClick={logOut}>
            <Icon name="logout" />
            Log out
          </button>
        </div>
      </header>
      <main className="content" id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
