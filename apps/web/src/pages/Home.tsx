import { useCallback, useEffect, useState } from 'react';

type Check = { status: 'ok' | 'error'; error?: string };
type Ready = { status: 'ok' | 'degraded'; checks: Record<string, Check> };

export default function Home() {
  const [data, setData] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/health/ready');
      // 503 still carries the per-dependency body
      const body = (await res.json()) as Ready;
      if (!body?.checks) throw new Error(`Unexpected response (HTTP ${res.status})`);
      setData(body);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="card">
      <div className="card-head">
        <h1>System status</h1>
        <button onClick={load} disabled={loading}>{loading ? 'Checking...' : 'Refresh'}</button>
      </div>
      {error && <p className="error" role="alert">Could not reach API: {error}</p>}
      {data && (
        <>
          <p>
            Overall: <span className={`badge ${data.status === 'ok' ? 'ok' : 'bad'}`}>{data.status}</span>
          </p>
          <table className="deps">
            <thead>
              <tr><th>Dependency</th><th>Status</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {Object.entries(data.checks).map(([name, c]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td><span className={`badge ${c.status === 'ok' ? 'ok' : 'bad'}`}>{c.status}</span></td>
                  <td className="muted">{c.error ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
