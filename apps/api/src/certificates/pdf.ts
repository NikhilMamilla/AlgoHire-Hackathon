import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { config } from '../config.js';

export type CertificateView = {
  certificateNo: string;
  candidateName: string;
  courseName: string;
  centreName: string;
  completionDate: Date;
  issuedAt: Date;
};

const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

// Full-page background (1492×1054 px, same aspect as A4 landscape). Read once, reused for every render.
let background: Buffer | undefined;
const backgroundImage = () => (background ??= readFileSync(new URL('../../assets/certificate-bg.png', import.meta.url)));

// Clean zones of certificate-bg.png in PDF points (image px × 841.89/1492).
const ZONE = {
  topRuleY: 109, // ornament line under the heading
  bottomRuleY: 503, // ornament line above the footer
  detailsBox: { x: 58, y: 376, w: 179, h: 90 }, // framed box, bottom left
  qrBox: { x: 668, y: 369, w: 102, h: 101 }, // framed box, bottom right
  textInset: 120, // keeps centred text clear of the corner guilloche
};

const NAVY = '#12355b';
const GOLD = '#9a6b1c';
const INK = '#1f2937';
const MUTED = '#5b6472';

/** Renders the certificate on demand from DB data (A4 landscape). Nothing is stored. */
export async function renderCertificatePdf(c: CertificateView): Promise<Buffer> {
  const verifyUrl = `${config.publicBaseUrl}/verify/${c.certificateNo}`;
  const qr = await QRCode.toBuffer(verifyUrl, { margin: 0, width: 360, errorCorrectionLevel: 'M', color: { dark: NAVY, light: '#00000000' } });

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate ${c.certificateNo}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width; // 841.89
  const H = doc.page.height; // 595.28
  doc.image(backgroundImage(), 0, 0, { width: W, height: H });

  const textW = W - 2 * ZONE.textInset;
  const centred = (s: string, y: number, font: string, size: number, color = INK) => {
    // Shrink long names/courses (up to 100 chars) to one line so they never collide with the next line.
    doc.font(font).fontSize(size);
    while (size > 10 && doc.widthOfString(s) > textW) doc.fontSize(--size);
    doc.fillColor(color).text(s, ZONE.textInset, y, { width: textW, align: 'center', lineBreak: false });
  };

  // Heading: above the top ornament line.
  centred('PRAGATI SKILLS MISSION', 50, 'Helvetica-Bold', 12, GOLD);
  centred('Certificate of Completion', 66, 'Times-Bold', 32, NAVY);

  // Body: between the ornament lines, above the framed boxes.
  centred('This certifies that', ZONE.topRuleY + 54, 'Times-Italic', 15, MUTED);
  centred(c.candidateName, ZONE.topRuleY + 78, 'Times-Bold', 32, INK);
  centred('has successfully completed', ZONE.topRuleY + 128, 'Times-Italic', 15, MUTED);
  centred(c.courseName, ZONE.topRuleY + 152, 'Helvetica-Bold', 20, INK);
  centred(`at ${c.centreName}`, ZONE.topRuleY + 182, 'Helvetica', 13, MUTED);

  // Bottom-left frame: dates and certificate number.
  const b = ZONE.detailsBox;
  const row = (label: string, value: string, i: number) => {
    const y = b.y + 8 + i * 27;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(label.toUpperCase(), b.x + 12, y, { characterSpacing: 0.6, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(value, b.x + 12, y + 9, { width: b.w - 24, lineBreak: false });
  };
  row('Completion date', fmt(c.completionDate), 0);
  row('Issue date', fmt(c.issuedAt), 1);
  row('Certificate no.', c.certificateNo, 2);

  // Bottom-right frame: QR code centred in it, verify URL under the frame.
  const q = ZONE.qrBox;
  const qrSize = 86;
  doc.image(qr, q.x + (q.w - qrSize) / 2, q.y + (q.h - qrSize) / 2, { width: qrSize });
  doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
    .text(verifyUrl, q.x + q.w / 2 - 110, q.y + q.h + 5, { width: 220, align: 'center', lineBreak: false });

  // Footer: below the bottom ornament line.
  centred(`Verify authenticity at ${verifyUrl}`, ZONE.bottomRuleY + 14, 'Helvetica', 8, MUTED);

  doc.end();
  return done;
}
