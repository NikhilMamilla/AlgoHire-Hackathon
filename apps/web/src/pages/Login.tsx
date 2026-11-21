import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAsync, type DemoUser, type User } from '../api';
import { useAuth } from '../App';
import { Alert, ROLE_LABEL, Skeleton, errorText } from '../components';

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
      navigate('/batches');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="brand brand-dark">CertiFlow</div>
        <h1>Choose a demo user</h1>
        <p className="note">Demo sign-in: no passwords. All permissions are enforced by the server.</p>
        {user && <p className="muted">Currently signed in as {user.name}. Pick another user to switch.</p>}
        {error && <Alert>{error}</Alert>}
        {users.loading && !users.data && <Skeleton rows={3} />}
        {users.error && <Alert>Could not load demo users: {errorText(users.error)}</Alert>}
        <div className="user-grid">
          {users.data?.users.map((u) => (
            <button key={u.id} className="user-card" onClick={() => choose(u)} disabled={busy !== null}>
              <span className="user-card-name">{u.name}</span>
              <span className="user-card-role">{ROLE_LABEL[u.role]}</span>
              <span className="muted">{u.centreName ?? u.districtName ?? 'State-wide'}</span>
              {busy === u.id && <span className="muted">Signing in…</span>}
            </button>
          ))}
        </div>
        <p className="muted small">
          Checking a certificate? <a href="/verify">Verify a certificate</a> — no sign-in needed.
        </p>
      </div>
    </div>
  );
}
