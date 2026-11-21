import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { api, session, type User } from './api';
import { ROLE_LABEL } from './components';
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

function Shell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  if (!user || !session.token()) return <Navigate to="/login" replace />;

  const switchUser = () => {
    signOut();
    navigate('/login');
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/" className="brand">
          CertiFlow
        </Link>
        <nav aria-label="Main">
          <NavLink to="/batches" className="nav-link">
            Batches
          </NavLink>
          {user.role === 'STATE' && (
            <>
              <NavLink to="/state" className="nav-link">
                State overview
              </NavLink>
              <NavLink to="/whatsapp" className="nav-link">
                WhatsApp outbox
              </NavLink>
            </>
          )}
          <a href="/verify" target="_blank" rel="noreferrer" className="nav-link">
            Verify a certificate ↗
          </a>
        </nav>
      </aside>
      <header className="topbar">
        <span className="topbar-title">Skilling certificate issuance</span>
        <div className="topbar-user">
          <div className="user-chip">
            <strong>{user.name}</strong>
            <span className="muted">
              {ROLE_LABEL[user.role]}
              {user.org ? ` · ${user.org}` : ''}
            </span>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={switchUser}>
            Switch user
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
