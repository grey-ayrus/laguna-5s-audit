import PDFDocument from 'pdfkit';
import { loadImageBuffer } from './storageService.js';

const SCORE_LABELS = {
  sort: 'Sort (Seiri)',
  setInOrder: 'Set in Order (Seiton)',
  shine: 'Shine (Seiso)',
  standardize: 'Standardize (Seiketsu)',
  sustain: 'Sustain (Shitsuke)',
};

const SEVERITY_COLOR = {
  critical: '#b91c1c',
  moderate: '#b45309',
  minor: '#15803d',
};

/**
 * Generates the audit PDF entirely in memory and resolves with a Buffer.
 * This is the only shape that works both locally and on Vercel's read-only
 * filesystem (no temp files on disk).
 *
 * Images are fetched via `storageService.loadImageBuffer` so they work
 * whether the audit stored a local `uploads/foo.jpg` path (dev) or an
 * absolute Blob URL (production).
 */
export function generateAuditPDFBuffer(audit) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 48, size: 'A4' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(20).fillColor('#1e3c72')
        .text('Laguna India Pvt Ltd, Doddaballapura', { align: 'center' });
      doc.font('Helvetica').fontSize(13).fillColor('#444')
        .text('Digital 5S Audit Report', { align: 'center' });
      doc.moveDown(0.6);

      doc.font('Helvetica-Bold').fontSize(16).fillColor('#1e3c72')
        .text(`${audit.zoneCode} - ${audit.zoneName}`);
      doc.font('Helvetica').fontSize(10).fillColor('#666')
        .text(`Category: ${audit.zoneCategory}`)
        .text(`Audited at: ${new Date(audit.createdAt).toLocaleString()}`)
        .text(`Status: ${audit.status}`);
      doc.moveDown(0.8);

      doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3c72')
        .text('5S Scores', { underline: true });
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(11).fillColor('#222');
      ['sort', 'setInOrder', 'shine', 'standardize', 'sustain'].forEach((s) => {
        const score = audit.scores?.[s] ?? 0;
        doc.text(`${SCORE_LABELS[s].padEnd(28, ' ')}  ${score}/4`);
      });
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3c72')
        .text(`Total: ${audit.scores?.total ?? 0}/20`);
      doc.moveDown(0.8);

      doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3c72')
        .text('Zone Summary', { underline: true });
      doc.font('Helvetica').fontSize(10).fillColor('#222')
        .text(audit.summary || audit.remarks || 'No summary available.', { align: 'justify' });
      doc.moveDown(0.8);

      doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3c72')
        .text('Issues Detected', { underline: true });
      doc.font('Helvetica').fontSize(10);
      if (!audit.issues || audit.issues.length === 0) {
        doc.fillColor('#15803d').text('No issues detected. Zone is in compliance.');
      } else {
        audit.issues.forEach((issue, i) => {
          const color = SEVERITY_COLOR[issue.severity] || '#222';
          const sLabel = SCORE_LABELS[issue.s] || issue.s;
          doc.fillColor(color)
            .text(`${i + 1}. [${(issue.severity || 'moderate').toUpperCase()}] ${sLabel}: ${issue.label}`);
        });
      }
      doc.moveDown(0.8);

      doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3c72')
        .text('Action Points', { underline: true });
      doc.font('Helvetica').fontSize(10).fillColor('#222');
      (audit.actionPoints || []).forEach((point, i) => {
        doc.text(`${i + 1}. ${point}`);
      });

      const images = audit.images || [];
      for (let idx = 0; idx < images.length; idx++) {
        const img = images[idx];
        const source = img.annotated || img.original;
        if (!source) continue;
        const buffer = await loadImageBuffer(source).catch(() => null);
        if (!buffer) continue;
        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3c72')
          .text(`Audit Image ${idx + 1}${img.annotated ? ' (annotated)' : ''}`, { underline: true });
        doc.moveDown(0.4);
        try {
          doc.image(buffer, { fit: [500, 600], align: 'center' });
        } catch (imgErr) {
          doc.fillColor('#b91c1c').text(`Image could not be embedded: ${imgErr.message}`);
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
