import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, useAsync, type DemoUser, type Role, type User } from '../api';
import { useAuth } from '../App';
import { Alert, Icon, Mark, errorText } from '../components';

/**
 * Accounts laid out by hierarchy, top to bottom: the state office decides last, reviewers sit in the middle,
 * and the training centre starts every batch. Each tier says what that level does.
 */
const TIERS: { key: string; level: string; title: string; does: string; groups: { role: Role; label: string }[] }[] = [
  {
    key: 'state',
    level: 'Tier 1',
    title: 'State office',
    does: 'Final approval, revocation and the state dashboard.',
    groups: [{ role: 'STATE', label: 'State office' }],
  },
  {
    key: 'review',
    level: 'Tier 2',
    title: 'Review',
    does: 'Two district officers approve each batch; the quality team checks batches of 50+.',
    groups: [
      { role: 'DISTRICT_OFFICER', label: 'District officers' },
      { role: 'QUALITY', label: 'Quality team' },
    ],
  },
  {
    key: 'centre',
    level: 'Tier 3',
    title: 'Training centre',
    does: 'Creates a batch, uploads the candidate CSV and submits it.',
    groups: [{ role: 'CENTRE', label: 'Training centre' }],
  },
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

  const byRole = (role: Role) => (users.data?.users ?? []).filter((u) => u.role === role).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <main className="signin mesh-bg" id="main" tabIndex={-1}>
      <header className="signin-top">
        <Link to="/" className="brand">
          <Mark size={28} />
          CertiFlow
        </Link>
        <nav className="signin-links" aria-label="Elsewhere">
          <Link to="/verify">Verify a certificate</Link>
          <Link to="/">Back to home</Link>
        </nav>
      </header>

      <div className="signin-body">
        <div className="signin-head">
          <div>
            <h1 id="signin-title">Sign in to CertiFlow</h1>
            <p className="signin-sub">Pick a demo account. Each one sees only what its role is allowed to see.</p>
          </div>
          <p className="signin-note">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z M9 12l2 2 4-4" />
            </svg>
            <span>Demo environment: sign-in is one click by design so reviewers can switch roles. Every permission is enforced by the server.</span>
          </p>
        </div>

        {user && <p className="signin-current">Signed in as {user.name}. Choose another account to switch.</p>}
        {error && <Alert>{error}</Alert>}
        {users.error && <Alert>Could not load demo accounts: {errorText(users.error)}</Alert>}

        <ol className="signin-tiers" aria-label="Demo accounts by hierarchy" aria-busy={users.loading}>
          {TIERS.map((tier) => (
            <li key={tier.key} className={`signin-tier tier-${tier.key}`}>
              <div className="signin-tier-label">
                <span className="signin-tier-dot" aria-hidden="true" />
                <span className="signin-tier-level">{tier.level}</span>
                <h2>{tier.title}</h2>
                <p>{tier.does}</p>
              </div>
              <div className="signin-tier-groups">
                {tier.groups.map((g) => (
                  <div key={g.role} className="signin-group" role="group" aria-label={g.label}>
                    {tier.groups.length > 1 && <span className="signin-group-label">{g.label}</span>}
                    <ul>
                      {users.loading && !users.data ? (
                        <li className="signin-skel" aria-hidden="true" />
                      ) : (
                        byRole(g.role).map((u) => (
                          <li key={u.id}>
                            <button className="user-card" onClick={() => choose(u)} disabled={busy !== null}>
                              <span className={`avatar avatar-${u.role.toLowerCase()}`} aria-hidden="true">
                                {initials(u.name)}
                              </span>
                              <span className="user-card-text">
                                <span className="user-card-name">{u.name}</span>
                                <span className="signin-scope" title={u.centreName ?? u.districtName ?? 'State-wide'}>
                                  {u.centreName ?? u.districtName ?? 'State-wide'}
                                </span>
                              </span>
                              <span className="user-card-action">
                                <span className="sr-only">{busy === u.id ? 'Signing in…' : 'Sign in'}</span>
                                <Icon name="chevron" />
                              </span>
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
