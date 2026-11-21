import { api, useAsync } from '../api';
import { Alert, Empty, Skeleton, errorText, fmtDateTime } from '../components';
import { useLiveReload } from '../useEvents';

type Message = { id: string; to: string; body: string; providerMessageId: string; createdAt: string };

/** Turns the URLs in a message into links so the demo can click "Download" / "Verify". */
function Linkified({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/\S+)/g).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

export default function Outbox() {
  const outbox = useAsync(() => api<{ messages: Message[] }>('/dev/outbox').then((r) => r.messages), []);
  useLiveReload(outbox.reload, (e) => e.type === 'delivery.status');

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Simulated WhatsApp outbox</h1>
          <p className="muted">Messages the simulated provider accepted. In production these would reach candidates' phones.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => void outbox.reload()}>
          Refresh
        </button>
      </div>
      {outbox.error && <Alert>{errorText(outbox.error)}</Alert>}
      {outbox.loading && !outbox.data ? (
        <Skeleton rows={4} />
      ) : !outbox.data?.length ? (
        <Empty title="No messages yet">Messages appear here as certificates are delivered.</Empty>
      ) : (
        <ul className="outbox">
          {outbox.data.map((m) => (
            <li key={m.id} className="message">
              <div className="message-head">
                <span className="mono">To {m.to}</span>
                <span className="muted small">{fmtDateTime(m.createdAt)}</span>
              </div>
              <p className="message-body">
                <Linkified text={m.body} />
              </p>
              <span className="muted small mono">{m.providerMessageId}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
