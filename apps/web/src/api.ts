import { useCallback, useEffect, useRef, useState } from 'react';

export type Role = 'CENTRE' | 'DISTRICT_OFFICER' | 'QUALITY' | 'STATE';
export type BatchStatus =
  | 'DRAFT'
  | 'DISTRICT_REVIEW'
  | 'QUALITY_REVIEW'
  | 'STATE_REVIEW'
  | 'APPROVED'
  | 'ISSUED'
  | 'RETURNED'
  | 'REJECTED';
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';

export type User = { id: string; name: string; role: Role; districtId: string | null; centreId: string | null; org?: string };
export type DemoUser = { id: string; name: string; role: Role; districtName: string | null; centreName: string | null };
export type BatchRow = {
  id: string;
  courseName: string;
  status: BatchStatus;
  round: number;
  stageEnteredAt: string | null;
  escalatedAt: string | null;
  createdAt: string;
  centreId: string;
  districtId: string;
  candidateCount: number;
  approvals: number;
  decidedByMe?: boolean;
  centre?: { id?: string; name: string };
};
export type Decision = {
  id: string;
  stage: 'DISTRICT' | 'QUALITY' | 'STATE';
  round: number;
  type: 'APPROVE' | 'REJECT' | 'RETURN';
  reason: string | null;
  createdAt: string;
  actor: { id: string; name: string };
};
export type AuditEntry = {
  id: string;
  action: string;
  actorId: string | null;
  actorName?: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};
export type Candidate = { id: string; candidateRef: string; fullName: string; phone: string; completionDate: string };
export type BatchDetail = Omit<BatchRow, 'candidateCount' | 'approvals'> & {
  district?: { name: string };
  candidates: Candidate[];
  decisions: Decision[];
  audit: AuditEntry[];
};
export type CertificateRow = {
  id: string;
  certificateNo: string;
  status: 'VALID' | 'REVOKED';
  candidate: { fullName: string; candidateRef: string };
  delivery: { status: DeliveryStatus; attempts: number; lastError: string | null; updatedAt: string } | null;
};
export type CsvError = { row: number; field: string; message: string };
export type AppEvent = {
  type: string;
  batchId?: string;
  certificateNo?: string;
  status?: string;
  districtId?: string;
  centreId?: string;
  at: string;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'certiflow.token';
const USER_KEY = 'certiflow.user';

export const session = {
  token: () => localStorage.getItem(TOKEN_KEY),
  user(): User | null {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  set(token: string, user: User) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  saveUser(user: User) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

const authHeaders = (): Record<string, string> => {
  const token = session.token();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

async function toError(res: Response) {
  const data = await res.json().catch(() => null);
  return new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? res.statusText, data?.error?.details);
}

function onUnauthorized(res: Response) {
  if (res.status === 401 && session.token()) {
    session.clear();
    window.location.assign('/login');
  }
}

/** fetch wrapper: adds the Bearer token, sends JSON or FormData, throws ApiError on { error }. */
export async function api<T>(path: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const headers = authHeaders();
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) body = init.form;
  const res = await fetch(`/api${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, cache: 'no-store' });
  onUnauthorized(res);
  if (!res.ok) throw await toError(res);
  return (await res.json().catch(() => null)) as T;
}

/** The PDF needs the Bearer header, so fetch it as a blob and save it via a temporary link. */
export async function downloadPdf(certNo: string) {
  const res = await fetch(`/api/certificates/${encodeURIComponent(certNo)}/pdf`, { headers: authHeaders(), cache: 'no-store' });
  onUnauthorized(res);
  if (!res.ok) throw await toError(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `${certNo}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Loads data with loading/error state; `reload` refetches without blanking the current data. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await fnRef.current();
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e as Error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setData(undefined);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload };
}
