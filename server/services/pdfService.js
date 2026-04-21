import PDFDocument from 'pdfkit';
import { loadImageBuffer } from './storageService.js';
import { loadReferenceImageForZone } from './referenceImageService.js';
import { getImageDimensions } from './imageDimensions.js';

const SCORE_LABELS = {
  sort: 'Sort (Seiri)',
  setInOrder: 'Set in Order (Seiton)',
  shine: 'Shine (Seiso)',
  standardize: 'Standardize (Seiketsu)',
  sustain: 'Sustain (Shitsuke)',
};

const SCORE_MAX_PER_S = 36;
const SCORE_MAX_TOTAL = SCORE_MAX_PER_S * 5;

function fmtFinal(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : '0.00';
}

// Convert a data URL (data:image/jpeg;base64,...) into a plain Buffer
// that pdfkit can embed. Returns null on failure.
function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch (_) { return null; }
}

// Severity -> text colour for the issues-detected list. We use the same
// palette in the box-overlay below but slightly darker for text contrast.
const SEVERITY_COLOR = {
  critical: '#b91c1c',
  moderate: '#b45309',
  minor: '#15803d',
};

// Brighter palette for the coloured rectangles drawn on top of the image
// itself, matching the client overlay.
const BOX_COLOR_BY_SEVERITY = {
  critical: '#dc2626',
  moderate: '#f97316',
  minor: '#facc15',
};

function boxColourForSeverity(sev) {
  return BOX_COLOR_BY_SEVERITY[sev] || BOX_COLOR_BY_SEVERITY.moderate;
}

/**
 * Draw `buffer` at `(x, y)` with the given maximum target width/height while
 * preserving the source image's aspect ratio. Also returns the actual drawn
 * width/height so the caller can overlay shapes at the exact same scale.
 *
 * This mirrors what `doc.image(buffer, { fit: [w, h] })` does internally but
 * gives us the dimensions we need to draw aligned annotations.
 */
function drawImageWithDimensions(doc, buffer, x, y, maxWidth, maxHeight) {
  const dims = getImageDimensions(buffer);
  if (!dims) {
    doc.image(buffer, x, y, { fit: [maxWidth, maxHeight] });
    return { width: maxWidth, height: maxHeight, x, y };
  }
  const ratio = dims.width / dims.height;
  let drawW = maxWidth;
  let drawH = drawW / ratio;
  if (drawH > maxHeight) {
    drawH = maxHeight;
    drawW = drawH * ratio;
  }
  const drawX = x + (maxWidth - drawW) / 2;
  const drawY = y + (maxHeight - drawH) / 2;
  doc.image(buffer, drawX, drawY, { width: drawW, height: drawH });
  return { width: drawW, height: drawH, x: drawX, y: drawY };
}

/**
 * Draw all issue & highlight boxes for a single capture. Coordinates on the
 * input are NORMALISED [x, y, w, h] (each value 0..1); we multiply by the
 * drawn image dimensions to get PDF points.
 */
function drawBoxesOverImage(doc, { issues = [], highlights = [] }, imageIndex, frame) {
  const relevantIssues = issues.filter((i) => (i.imageIndex ?? i.image_index ?? 0) === imageIndex && Array.isArray(i.box) && i.box.length === 4);
  const relevantHighlights = highlights.filter((h) => (h.imageIndex ?? h.image_index ?? 0) === imageIndex && Array.isArray(h.box) && h.box.length === 4);

  if (!relevantIssues.length && !relevantHighlights.length) return 0;

  doc.save();

  // Highlights first (green, dashed) so issues render on top.
  for (const h of relevantHighlights) {
    const [bx, by, bw, bh] = h.box;
    const x = frame.x + bx * frame.width;
    const y = frame.y + by * frame.height;
    const w = bw * frame.width;
    const bh2 = bh * frame.height;
    doc.lineWidth(1.5).dash(4, { space: 2 }).strokeColor('#16a34a').rect(x, y, w, bh2).stroke();
    doc.undash();
  }

  for (const i of relevantIssues) {
    const [bx, by, bw, bh] = i.box;
    const x = frame.x + bx * frame.width;
    const y = frame.y + by * frame.height;
    const w = bw * frame.width;
    const bh2 = bh * frame.height;
    const colour = boxColourForSeverity(i.severity);
    doc.lineWidth(i.severity === 'critical' ? 2.5 : 1.8).strokeColor(colour).rect(x, y, w, bh2).stroke();

    // Small filled tag with the severity initial in the top-left corner.
    const tag = (i.severity || 'M')[0].toUpperCase();
    const tagW = 12;
    const tagH = 12;
    doc.fillColor(colour).rect(x, y, tagW, tagH).fill();
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text(tag, x + 2.8, y + 2.2, { lineBreak: false });
  }

  doc.restore();
  return relevantIssues.length + relevantHighlights.length;
}

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
        doc.text(`${SCORE_LABELS[s].padEnd(28, ' ')}  ${score}/${SCORE_MAX_PER_S}`);
      });
      doc.moveDown(0.4);
      const total = audit.scores?.total ?? 0;
      const imageCount = audit.scores?.imageCount ?? Math.max(1, (audit.images || []).length || 1);
      const totalFinal = audit.scores?.totalFinal
        ?? (total / (SCORE_MAX_TOTAL * imageCount)) * 10;
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#1e3c72')
        .text(`Raw total: ${total}/${SCORE_MAX_TOTAL * imageCount} (${imageCount} image${imageCount === 1 ? '' : 's'})`);
      doc.moveDown(0.2);
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#1e3c72')
        .text(`Final score: ${fmtFinal(totalFinal)} / 10.00   (${audit.status})`);
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

      // Reference / "standard" page. Try the zone's canonical reference first
      // (reliably bundled with the function), then fall back to whatever URL
      // was stored on the audit document.
      const referenceBuffer = await (async () => {
        const canonical = dataUrlToBuffer(loadReferenceImageForZone(audit.zoneId));
        if (canonical) return canonical;
        if (audit.referenceImage) {
          return await loadImageBuffer(audit.referenceImage).catch(() => null);
        }
        return null;
      })();

      if (referenceBuffer) {
        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3c72')
          .text('Reference (Standard) Image', { underline: true });
        doc.font('Helvetica').fontSize(10).fillColor('#666')
          .text('The zone should look like this when 5S is fully implemented.');
        doc.moveDown(0.4);
        try {
          doc.image(referenceBuffer, { fit: [500, 600], align: 'center' });
        } catch (imgErr) {
          doc.fillColor('#b91c1c').text(`Reference image could not be embedded: ${imgErr.message}`);
        }
      }

      const images = audit.images || [];
      for (let idx = 0; idx < images.length; idx++) {
        const img = images[idx];
        const source = img.original || img.annotated; // Prefer the raw capture so our own box-overlay stays visible.
        if (!source) continue;
        const buffer = await loadImageBuffer(source).catch(() => null);
        if (!buffer) continue;
        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3c72')
          .text(`Captured Image ${idx + 1}`, { underline: true });
        doc.moveDown(0.4);

        // Leave room underneath for a short list of annotations.
        const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const startY = doc.y + 4;
        const maxHeight = 520;
        let frame;
        try {
          frame = drawImageWithDimensions(
            doc,
            buffer,
            doc.page.margins.left,
            startY,
            pageWidth,
            maxHeight,
          );
        } catch (imgErr) {
          doc.fillColor('#b91c1c').text(`Image could not be embedded: ${imgErr.message}`);
          continue;
        }

        const drawnCount = drawBoxesOverImage(doc, {
          issues: audit.issues || [],
          highlights: audit.highlights || [],
        }, idx, frame);

        // Cursor lands below the drawn image.
        doc.y = frame.y + frame.height + 14;

        const annotationsForImage = (audit.issues || []).filter((i) => (i.imageIndex ?? i.image_index ?? 0) === idx && Array.isArray(i.box));
        const highlightsForImage = (audit.highlights || []).filter((h) => (h.imageIndex ?? h.image_index ?? 0) === idx && Array.isArray(h.box));

        if (drawnCount > 0) {
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#1e3c72')
            .text(`Annotations (${drawnCount})`);
          doc.moveDown(0.1);
          doc.font('Helvetica').fontSize(9);
          annotationsForImage.forEach((issue, n) => {
            const colour = boxColourForSeverity(issue.severity);
            doc.fillColor(colour)
              .text(`${n + 1}. [${(issue.severity || 'moderate').toUpperCase()}] ${issue.label}`);
          });
          if (highlightsForImage.length) {
            doc.fillColor('#16a34a');
            highlightsForImage.forEach((h) => {
              doc.text(`OK · ${h.label}`);
            });
          }
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
