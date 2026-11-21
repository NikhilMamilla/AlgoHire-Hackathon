import { useEffect, useRef } from 'react';
import { session, type AppEvent } from './api';

/**
 * Live server events over SSE. EventSource can't send headers, so the JWT goes in ?token=.
 * The browser reconnects by itself after network errors; if the server closes the stream for good
 * (e.g. a restart answered with an error), we reopen it after 5s.
 */
export function useEvents(onEvent: (e: AppEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const token = session.token();

  useEffect(() => {
    if (!token) return;
    let es: EventSource | null = null;
    let retry: number | undefined;
    let stopped = false;
    const connect = () => {
      es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      es.onmessage = (m) => {
        try {
          handler.current(JSON.parse(m.data) as AppEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onerror = () => {
        if (es?.readyState === EventSource.CLOSED && !stopped) retry = window.setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      es?.close();
    };
  }, [token]);
}

/** Refetch (debounced) when a matching event arrives. */
export function useLiveReload(reload: () => void, match: (e: AppEvent) => boolean = () => true, delayMs = 300) {
  const timer = useRef<number>();
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const matchRef = useRef(match);
  matchRef.current = match;

  useEvents((e) => {
    if (!matchRef.current(e)) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => reloadRef.current(), delayMs);
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);
}
