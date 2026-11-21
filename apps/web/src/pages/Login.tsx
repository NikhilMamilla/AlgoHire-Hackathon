import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, useAsync, type DemoUser, type Role, type User } from '../api';
import { useAuth } from '../App';
import { Alert, Skeleton, errorText } from '../components';

const GROUPS: { role: Role; label: string }[] = [
  { role: 'CENTRE', label: 'Training centre' },
  { role: 'DISTRICT_OFFICER', label: 'District officers' },
  { role: 'QUALITY', label: 'Quality team' },
  { role: 'STATE', label: 'State office' },
];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

export const homeFor = (role: Role) => (role === 'STATE' ? '/state' : '/batches');

export default function Login() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const users = useAsync(() => api<{ users: DemoUser[] }>('/auth/demo-users'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (u: DemoUser) => {
    setBusy(u.id);
    setError(null);
    try {
      const res = await api<{ token: string; user: User }>('/auth/demo-login', { json: { userId: u.id } });
      signIn(res.token, { ...res.user, org: u.centreName ?? u.districtName ?? 'State-wide' });
      navigate(homeFor(res.user.role));
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  return (
    <div className="login-page">
      <div className="signin-card">
        <Link to="/" className="brand brand-dark">
          CertiFlow
        </Link>
        <h1>Sign in to CertiFlow</h1>
        <p className="signin-note">
          Demo environment: sign-in is one click by design so reviewers can switch roles. Every permission is enforced by the server.
        </p>
        {user && <p className="muted small">Signed in as {user.name}. Choose another user to switch.</p>}
        {error && <Alert>{error}</Alert>}
        {users.error && <Alert>Could not load demo users: {errorText(users.error)}</Alert>}
        {users.loading && !users.data && <Skeleton rows={4} />}

        {users.data &&
          GROUPS.map((g) => {
            const members = users.data!.users.filter((u) => u.role === g.role);
            if (!members.length) return null;
            return (
              <section key={g.role} className="signin-group" aria-labelledby={`group-${g.role}`}>
                <h2 id={`group-${g.role}`}>{g.label}</h2>
                <ul>
                  {members.map((u) => (
                    <li key={u.id}>
                      <button className="user-card" onClick={() => choose(u)} disabled={busy !== null}>
                        <span className="avatar" aria-hidden="true">
                          {initials(u.name)}
                        </span>
                        <span className="user-card-text">
                          <span className="user-card-name">{u.name}</span>
                          <span className="muted small">{u.centreName ?? u.districtName ?? 'State-wide'}</span>
                        </span>
                        <span className="user-card-action">{busy === u.id ? 'Signing in…' : 'Sign in'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

        <p className="muted small signin-foot">
          Checking a certificate? <Link to="/verify">Verify it here</Link>, no sign-in needed.
        </p>
      </div>
    </div>
  );
}
