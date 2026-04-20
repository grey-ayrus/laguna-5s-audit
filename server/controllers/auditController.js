/**
 * Audit controller for the v2 zone-based 5S system.
 *
 * Notable behaviour:
 *   - Accepts 1..4 base64 images per audit, no reference image needed.
 *   - Looks up the latest 5 prior audits for the same zone and passes their
 *     summarised issue list to the Python engine for the Sustain check.
 *   - Persists original + annotated images side-by-side under /uploads.
 *   - Falls back to in-memory storage when MongoDB is not reachable.
 *   - Auto-migrates legacy 7-section audits (saved under the old schema) so
 *     they remain visible in the new dashboard.
 */
import Audit from '../models/Audit.js';
import { analyzeAudit } from '../services/imageAnalysisService.js';
import { generateAuditPDFBuffer } from '../services/pdfService.js';
import { saveImage } from '../services/storageService.js';
import { ZONES, resolveZone, LEGACY_SECTION_MAP, ZONE_BY_ID } from '../config/zones.js';

const inMemoryAudits = [];
let inMemoryCounter = 1;
const HISTORY_LIMIT = 5;

const useMongo = () => Boolean(global.mongoConnected);

function stripBase64Prefix(input) {
  if (!input) return '';
  return input.includes(',') ? input.split(',')[1] : input;
}

async function fetchHistory(zoneId) {
  let history = [];
  if (useMongo()) {
    try {
      const docs = await Audit.find({ zoneId })
        .sort({ createdAt: -1 })
        .limit(HISTORY_LIMIT)
        .lean();
      history = docs;
    } catch (err) {
      console.warn('History fetch from MongoDB failed:', err.message);
    }
  }
  if (history.length === 0) {
    history = inMemoryAudits
      .filter((a) => a.zoneId === zoneId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, HISTORY_LIMIT);
  }
  return history.map((a) => ({
    scores: a.scores,
    issues: (a.issues || []).map((i) => ({ tag: i.tag, label: i.label, s: i.s })),
    createdAt: a.createdAt,
  }));
}

export async function createAudit(req, res) {
  try {
    const { zoneId, images, aiProvider, aiModel, aiKey } = req.body;

    if (!zoneId) {
      return res.status(400).json({ error: 'zoneId is required' });
    }
    const zone = resolveZone(zoneId);
    if (!zone) {
      return res.status(400).json({ error: `Unknown zone: ${zoneId}` });
    }
    if (!Array.isArray(images) || images.length < 1 || images.length > 4) {
      return res.status(400).json({ error: 'Provide between 1 and 4 images' });
    }

    const imagesBase64 = images.map(stripBase64Prefix).filter(Boolean);
    if (imagesBase64.length === 0) {
      return res.status(400).json({ error: 'All provided images were empty' });
    }

    const history = await fetchHistory(zone.id);

    const result = await analyzeAudit({
      zoneId: zone.id,
      imagesBase64: imagesBase64.map((b) => `data:image/jpeg;base64,${b}`),
      history,
      aiProvider,
      aiModel,
      aiKey,
    });

    const ts = Date.now();
    const savedImages = await Promise.all(imagesBase64.map(async (b64, idx) => {
      const original = await saveImage({
        prefix: 'orig',
        index: idx,
        timestamp: ts,
        buffer: Buffer.from(b64, 'base64'),
      });
      let annotated = null;
      const annotatedB64 = result.annotatedImages?.[idx];
      if (annotatedB64) {
        const cleaned = stripBase64Prefix(annotatedB64);
        annotated = await saveImage({
          prefix: 'annot',
          index: idx,
          timestamp: ts,
          buffer: Buffer.from(cleaned, 'base64'),
        });
      }
      return { original, annotated };
    }));

    const auditDoc = {
      zoneId: zone.id,
      zoneCode: zone.code,
      zoneName: zone.name,
      zoneCategory: zone.category,
      legacySectionName: null,
      images: savedImages,
      scores: result.scores,
      issues: (result.issues || []).map((i) => ({
        s: i.s,
        label: i.label,
        severity: i.severity || 'moderate',
        tag: i.tag,
        imageIndex: i.image_index ?? 0,
        box: i.box || undefined,
      })),
      actionPoints: result.actionPoints || [],
      summary: result.summary || '',
      remarks: result.remarks || '',
      status: result.status,
      engine: result.engine || 'python',
      createdAt: new Date(),
    };

    let saved;
    if (useMongo()) {
      try {
        const doc = new Audit(auditDoc);
        saved = (await doc.save()).toObject();
      } catch (dbErr) {
        console.warn('Mongo save failed - using in-memory storage:', dbErr.message);
        saved = { _id: `mem_${inMemoryCounter++}`, ...auditDoc };
        inMemoryAudits.push(saved);
      }
    } else {
      saved = { _id: `mem_${inMemoryCounter++}`, ...auditDoc };
      inMemoryAudits.push(saved);
    }

    res.status(201).json({ success: true, audit: saved, storage: useMongo() ? 'mongodb' : 'in-memory' });
  } catch (err) {
    console.error('createAudit failed:', err);
    res.status(500).json({ error: 'Failed to create audit', details: err.message });
  }
}

function migrateLegacy(doc) {
  if (!doc) return doc;
  if (doc.zoneId) return doc;

  const sectionName = doc.sectionName || doc.legacySectionName;
  const mappedZoneId = sectionName ? LEGACY_SECTION_MAP[sectionName] : null;
  const zone = mappedZoneId ? ZONE_BY_ID[mappedZoneId] : null;

  // Convert old /20 scores to /4 buckets so they fit the new dashboard.
  const toBucket = (n) => {
    if (n == null) return 2;
    const v = Number(n);
    if (v >= 17) return 4;
    if (v >= 13) return 3;
    if (v >= 9) return 2;
    return 1;
  };
  const oldScores = doc.scores || {};
  const newScores = {
    sort: toBucket(oldScores.sort),
    setInOrder: toBucket(oldScores.setInOrder),
    shine: toBucket(oldScores.shine),
    standardize: toBucket(oldScores.standardize),
    sustain: toBucket(oldScores.sustain),
  };
  newScores.total = newScores.sort + newScores.setInOrder + newScores.shine + newScores.standardize + newScores.sustain;

  const status = newScores.total >= 16 ? 'Green' : newScores.total >= 11 ? 'Yellow' : 'Red';

  const images = [];
  if (doc.referenceImage) images.push({ original: doc.referenceImage, annotated: null });
  if (doc.currentImage) images.push({ original: doc.currentImage, annotated: null });

  return {
    ...doc,
    zoneId: zone ? zone.id : 'legacy',
    zoneCode: zone ? zone.code : 'Legacy',
    zoneName: zone ? zone.name : (sectionName || 'Legacy Audit'),
    zoneCategory: zone ? zone.category : 'Legacy',
    legacySectionName: sectionName,
    images,
    scores: newScores,
    issues: (doc.observations || []).map((text) => ({
      s: 'sort', label: text, severity: 'moderate', tag: 'Legacy observation',
      imageIndex: 0,
    })),
    actionPoints: doc.actionPoints || [],
    summary: doc.remarks || `Legacy audit migrated from ${sectionName || 'unknown section'}.`,
    remarks: doc.remarks || '',
    status,
    isLegacy: true,
  };
}

export async function getAllAudits(req, res) {
  try {
    const { zoneId, startDate, endDate } = req.query;

    let audits;
    if (useMongo()) {
      try {
        const filter = {};
        if (zoneId) filter.zoneId = zoneId;
        if (startDate || endDate) {
          filter.createdAt = {};
          if (startDate) filter.createdAt.$gte = new Date(startDate);
          if (endDate)   filter.createdAt.$lte = new Date(endDate);
        }
        const docs = await Audit.find(filter).sort({ createdAt: -1 }).lean();
        audits = docs.map(migrateLegacy);
      } catch (err) {
        console.warn('Mongo find failed - using in-memory:', err.message);
        audits = filterMemory(zoneId, startDate, endDate).map(migrateLegacy);
      }
    } else {
      audits = filterMemory(zoneId, startDate, endDate).map(migrateLegacy);
    }

    res.json({
      success: true,
      count: audits.length,
      audits,
      storage: useMongo() ? 'mongodb' : 'in-memory',
    });
  } catch (err) {
    console.error('getAllAudits failed:', err);
    res.status(500).json({ error: 'Failed to fetch audits' });
  }
}

function filterMemory(zoneId, startDate, endDate) {
  let list = [...inMemoryAudits];
  if (zoneId) list = list.filter((a) => a.zoneId === zoneId);
  if (startDate) list = list.filter((a) => new Date(a.createdAt) >= new Date(startDate));
  if (endDate)   list = list.filter((a) => new Date(a.createdAt) <= new Date(endDate));
  return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getAuditById(req, res) {
  try {
    const { id } = req.params;
    let audit;
    if (useMongo() && !id.startsWith('mem_')) {
      try {
        const doc = await Audit.findById(id).lean();
        if (doc) audit = migrateLegacy(doc);
      } catch (err) {
        console.warn('Mongo findById failed:', err.message);
      }
    }
    if (!audit) {
      audit = inMemoryAudits.find((a) => a._id === id);
      if (audit) audit = migrateLegacy(audit);
    }
    if (!audit) return res.status(404).json({ error: 'Audit not found' });
    res.json({ success: true, audit });
  } catch (err) {
    console.error('getAuditById failed:', err);
    res.status(500).json({ error: 'Failed to fetch audit' });
  }
}

export async function getAuditStats(req, res) {
  try {
    const allAudits = await fetchAllAuditsForStats();
    const stats = computeStats(allAudits);
    res.json({ success: true, stats, storage: useMongo() ? 'mongodb' : 'in-memory' });
  } catch (err) {
    console.error('getAuditStats failed:', err);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
}

async function fetchAllAuditsForStats() {
  if (useMongo()) {
    try {
      const docs = await Audit.find({}).sort({ createdAt: -1 }).lean();
      return docs.map(migrateLegacy);
    } catch (err) {
      console.warn('Mongo stats fetch failed - using in-memory:', err.message);
    }
  }
  return inMemoryAudits.map(migrateLegacy);
}

function computeStats(audits) {
  const byZone = new Map();
  const byStatus = { Green: 0, Yellow: 0, Red: 0 };
  const byDate = new Map();

  audits.forEach((a) => {
    if (!byZone.has(a.zoneId)) {
      byZone.set(a.zoneId, {
        zoneId: a.zoneId,
        zoneCode: a.zoneCode,
        zoneName: a.zoneName,
        category: a.zoneCategory,
        totalScore: 0,
        count: 0,
        latestScore: null,
        latestAt: null,
      });
    }
    const z = byZone.get(a.zoneId);
    z.totalScore += a.scores.total;
    z.count += 1;
    if (!z.latestAt || new Date(a.createdAt) > new Date(z.latestAt)) {
      z.latestScore = a.scores.total;
      z.latestAt = a.createdAt;
    }

    if (byStatus[a.status] !== undefined) byStatus[a.status] += 1;

    const dateStr = new Date(a.createdAt).toISOString().split('T')[0];
    if (!byDate.has(dateStr)) byDate.set(dateStr, { totalScore: 0, count: 0 });
    const d = byDate.get(dateStr);
    d.totalScore += a.scores.total;
    d.count += 1;
  });

  const zoneStats = [...byZone.values()].map((z) => ({
    ...z,
    averageScore: z.count > 0 ? z.totalScore / z.count : 0,
  }));

  const statusDistribution = Object.entries(byStatus).map(([status, count]) => ({ status, count }));

  const trendData = [...byDate.entries()]
    .map(([date, v]) => ({ date, averageScore: v.totalScore / v.count, count: v.count }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);

  // Best / worst zones (by average score, only if at least one audit exists).
  const sortedZones = [...zoneStats].sort((a, b) => b.averageScore - a.averageScore);
  const best = sortedZones[0] || null;
  const worst = sortedZones[sortedZones.length - 1] || null;

  return {
    totalAudits: audits.length,
    zoneStats,
    statusDistribution,
    trendData,
    bestZone: best,
    worstZone: worst,
    zonesAudited: zoneStats.length,
    zonesTotal: ZONES.length,
  };
}

export async function downloadAuditPDF(req, res) {
  try {
    const { id } = req.params;
    let audit;
    if (useMongo() && !id.startsWith('mem_')) {
      try {
        const doc = await Audit.findById(id).lean();
        if (doc) audit = migrateLegacy(doc);
      } catch (err) {
        console.warn('Mongo PDF fetch failed:', err.message);
      }
    }
    if (!audit) {
      audit = inMemoryAudits.find((a) => a._id === id);
      if (audit) audit = migrateLegacy(audit);
    }
    if (!audit) return res.status(404).json({ error: 'Audit not found' });

    const buffer = await generateAuditPDFBuffer(audit);
    const filename = `5S_Audit_${audit.zoneCode}_${new Date(audit.createdAt).toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('downloadAuditPDF failed:', err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
}

export async function listZones(req, res) {
  res.json({ success: true, zones: ZONES });
}
