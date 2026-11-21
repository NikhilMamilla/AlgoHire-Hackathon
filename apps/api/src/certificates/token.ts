import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** Candidate download link token: base64url HMAC-SHA256 of the certificate number. */
export const downloadToken = (certNo: string) =>
  createHmac('sha256', config.downloadTokenSecret).update(certNo).digest('base64url');

export function verifyDownloadToken(certNo: string, token: string) {
  const expected = Buffer.from(downloadToken(certNo));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
