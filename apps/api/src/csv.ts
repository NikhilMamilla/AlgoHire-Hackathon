import { parse } from 'csv-parse/sync';

export const HEADER = ['candidate_ref', 'full_name', 'phone', 'completion_date'] as const;
export const MAX_ROWS = 500;

export type CsvError = { row: number; field: string; message: string };
export type CandidateRow = { candidateRef: string; fullName: string; phone: string; completionDate: Date };

const REF = /^[A-Za-z0-9-]{3,32}$/;
const PHONE = /^[6-9]\d{9}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Completion dates are calendar dates in India, so "today" is the IST date.
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/** Validates every row and collects all errors. Row numbers are spreadsheet lines (header = 1). */
export function parseCandidatesCsv(buf: Buffer, today = istToday()): { rows: CandidateRow[]; errors: CsvError[] } {
  let records: { record: string[]; info: { lines: number } }[];
  try {
    // bom strips a UTF-8 BOM; record delimiter auto-detects \n and \r\n.
    records = parse(buf, { bom: true, trim: true, skip_empty_lines: true, relax_column_count: true, info: true });
  } catch (e) {
    return { rows: [], errors: [{ row: (e as { lines?: number }).lines ?? 1, field: 'file', message: `Unreadable CSV: ${(e as Error).message}` }] };
  }

  const [header, ...data] = records;
  if (!header || header.record.join(',') !== HEADER.join(',')) {
    return { rows: [], errors: [{ row: 1, field: 'header', message: `Header must be exactly: ${HEADER.join(',')}` }] };
  }
  if (data.length === 0) return { rows: [], errors: [{ row: 2, field: 'file', message: 'CSV has no data rows' }] };
  if (data.length > MAX_ROWS) {
    return { rows: [], errors: [{ row: data[MAX_ROWS].info.lines, field: 'file', message: `Too many rows: maximum is ${MAX_ROWS}` }] };
  }

  const errors: CsvError[] = [];
  const rows: CandidateRow[] = [];
  const firstSeen = new Map<string, number>();

  for (const { record, info } of data) {
    const row = info.lines;
    if (record.length !== HEADER.length) {
      errors.push({ row, field: 'row', message: `Row has ${record.length} columns, expected ${HEADER.length}` });
      continue;
    }
    const [ref, name, phone, date] = record;
    const before = errors.length;
    const err = (field: string, message: string) => errors.push({ row, field, message });

    if (!ref) err('candidate_ref', 'candidate_ref is required');
    else if (!REF.test(ref)) err('candidate_ref', 'candidate_ref must be 3-32 letters, digits or hyphens');
    else if (firstSeen.has(ref)) err('candidate_ref', `Duplicate candidate_ref ${ref} (first seen on row ${firstSeen.get(ref)})`);
    else firstSeen.set(ref, row);

    if (!name) err('full_name', 'full_name is required');
    else if (name.length < 2 || name.length > 100) err('full_name', 'full_name must be 2-100 characters');

    if (!phone) err('phone', 'phone is required');
    else if (!PHONE.test(phone)) err('phone', 'phone must be a 10-digit Indian mobile number starting with 6-9');

    // Round-trip through Date to reject impossible dates like 2026-02-30 or 2026-13-40.
    const d = DATE.test(date) ? new Date(`${date}T00:00:00Z`) : null;
    if (!date) err('completion_date', 'completion_date is required');
    else if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date)
      err('completion_date', 'completion_date must be a real date in YYYY-MM-DD format');
    else if (date > today) err('completion_date', 'completion_date cannot be in the future');

    if (errors.length === before) rows.push({ candidateRef: ref, fullName: name, phone, completionDate: d! });
  }
  return { rows, errors };
}
