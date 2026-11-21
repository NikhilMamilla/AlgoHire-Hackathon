import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CERT_NO = /^CF-[0-9A-HJKMNP-TV-Z]{10}$/;

/** "CF-" + 10 Crockford base32 chars = 50 random bits (each char takes the low 5 bits of one random byte). */
export const newCertificateNo = () =>
  'CF-' + [...randomBytes(10)].map((b) => CROCKFORD[b & 31]).join('');
