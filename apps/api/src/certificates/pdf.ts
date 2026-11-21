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

/** Renders the certificate on demand from DB data (A4 landscape). Nothing is stored. */
export async function renderCertificatePdf(c: CertificateView): Promise<Buffer> {
  const verifyUrl = `${config.publicBaseUrl}/verify/${c.certificateNo}`;
  const qr = await QRCode.toBuffer(verifyUrl, { margin: 1, width: 360, errorCorrectionLevel: 'M' });

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate ${c.certificateNo}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width; // 841.89
  const H = doc.page.height; // 595.28
  const ink = '#1f2937';
  const muted = '#6b7280';
  const accent = '#1d4ed8';

  // Thin double border.
  doc.lineWidth(1.5).strokeColor(accent).rect(24, 24, W - 48, H - 48).stroke();
  doc.lineWidth(0.6).rect(32, 32, W - 64, H - 64).stroke();

  const text = (s: string, y: number, font: string, size: number, color = ink) => {
    // Shrink long names/courses (up to 100 chars) to one line so they never push into the next line.
    doc.font(font).fontSize(size);
    while (size > 10 && doc.widthOfString(s) > W - 120) doc.fontSize(--size);
    doc.fillColor(color).text(s, 60, y, { width: W - 120, align: 'center', lineBreak: false });
  };

  text('PRAGATI SKILLS MISSION', 70, 'Helvetica-Bold', 14, accent);
  text('Certificate of Completion', 98, 'Times-Bold', 38);
  text('This certifies that', 178, 'Times-Italic', 16, muted);
  text(c.candidateName, 204, 'Times-Bold', 30);
  text('has successfully completed', 252, 'Times-Italic', 16, muted);
  text(c.courseName, 276, 'Helvetica-Bold', 20);
  text(`at ${c.centreName}`, 308, 'Helvetica', 14, muted);

  // Dates and number, left block.
  const lx = 80;
  const row = (label: string, value: string, y: number) => {
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(label.toUpperCase(), lx, y);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(ink).text(value, lx, y + 12);
  };
  row('Completion date', fmt(c.completionDate), 380);
  row('Issue date', fmt(c.issuedAt), 420);
  row('Certificate no.', c.certificateNo, 460);

  // QR bottom right with the URL under it.
  const qrSize = 110;
  const qx = W - 80 - qrSize;
  const qy = H - 80 - qrSize - 24;
  doc.image(qr, qx, qy, { width: qrSize });
  doc.font('Helvetica').fontSize(7).fillColor(muted).text(verifyUrl, qx - 60, qy + qrSize + 6, { width: qrSize + 120, align: 'center' });

  doc.font('Helvetica').fontSize(8).fillColor(muted).text(`Verify authenticity at ${verifyUrl}`, 60, H - 52, { width: W - 120, align: 'center' });

  doc.end();
  return done;
}
