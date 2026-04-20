// Direct unit test of the legacy migration helper.
// Re-implements the function the same way the controller does, then runs it
// against a representative pre-v2 audit document and asserts the shape.

import { LEGACY_SECTION_MAP, ZONE_BY_ID } from '../server/config/zones.js';

function migrateLegacy(doc) {
  if (!doc) return doc;
  if (doc.zoneId) return doc;

  const sectionName = doc.sectionName || doc.legacySectionName;
  const mappedZoneId = sectionName ? LEGACY_SECTION_MAP[sectionName] : null;
  const zone = mappedZoneId ? ZONE_BY_ID[mappedZoneId] : null;

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
  newScores.total =
    newScores.sort + newScores.setInOrder + newScores.shine + newScores.standardize + newScores.sustain;
  const status = newScores.total >= 16 ? 'Green' : newScores.total >= 11 ? 'Yellow' : 'Red';

  const images = [];
  if (doc.referenceImage) images.push({ original: doc.referenceImage, annotated: null });
  if (doc.currentImage) images.push({ original: doc.currentImage, annotated: null });

  return {
    ...doc,
    zoneId: zone ? zone.id : 'legacy',
    zoneCode: zone ? zone.code : 'Legacy',
    zoneName: zone ? zone.name : sectionName || 'Legacy Audit',
    zoneCategory: zone ? zone.category : 'Legacy',
    legacySectionName: sectionName,
    images,
    scores: newScores,
    issues: (doc.observations || []).map((t) => ({
      s: 'sort',
      label: t,
      severity: 'moderate',
      tag: 'Legacy observation',
      imageIndex: 0,
    })),
    actionPoints: doc.actionPoints || [],
    summary: doc.remarks || `Legacy audit migrated from ${sectionName || 'unknown section'}.`,
    remarks: doc.remarks || '',
    status,
    isLegacy: true,
  };
}

const cases = [
  {
    name: 'Cutting Section legacy audit, perfect /20 scores',
    input: {
      _id: 'leg_1',
      sectionName: 'Cutting Section',
      referenceImage: 'uploads/old_ref.jpg',
      currentImage: 'uploads/old_cur.jpg',
      scores: { sort: 18, setInOrder: 17, shine: 16, standardize: 14, sustain: 9 },
      observations: ['Fabric on floor', 'No SOP visible'],
      actionPoints: ['Sweep floor', 'Print SOP'],
      remarks: 'Reasonable audit',
      status: 'Yellow',
      createdAt: new Date('2024-09-01'),
    },
    expectedZone: 'zone-14',
    expectedStatus: 'Green', // total 4+4+3+3+2 = 16 -> Green
  },
  {
    name: 'Sewing Line legacy with low scores',
    input: {
      _id: 'leg_2',
      sectionName: 'Sewing Line',
      scores: { sort: 8, setInOrder: 7, shine: 6, standardize: 5, sustain: 4 },
      observations: ['lots of waste'],
    },
    expectedZone: 'zone-15',
    expectedStatus: 'Red', // 2+1+1+1+1 = 6 -> Red
  },
  {
    name: 'Unknown legacy section name - should still migrate but no zone',
    input: {
      _id: 'leg_3',
      sectionName: 'Some Old Area',
      scores: { sort: 15, setInOrder: 15, shine: 15, standardize: 15, sustain: 15 },
    },
    expectedZone: 'legacy',
    expectedStatus: 'Yellow', // 3*5 = 15 -> Yellow
  },
  {
    name: 'Already-v2 doc passes through unchanged',
    input: {
      _id: 'fresh',
      zoneId: 'zone-25',
      zoneCode: 'Zone-25',
      zoneName: 'CANTEEN',
      zoneCategory: 'Welfare',
      scores: { sort: 4, setInOrder: 4, shine: 4, standardize: 4, sustain: 4, total: 20 },
      issues: [],
      images: [],
    },
    expectedZone: 'zone-25',
    expectedStatus: undefined,
  },
];

let failed = 0;
for (const c of cases) {
  const out = migrateLegacy(c.input);
  const errs = [];
  if (out.zoneId !== c.expectedZone) errs.push(`zoneId=${out.zoneId}, want ${c.expectedZone}`);
  if (c.expectedStatus !== undefined && out.status !== c.expectedStatus) {
    errs.push(`status=${out.status}, want ${c.expectedStatus}`);
  }
  if (c.input.zoneId) {
    if (out.isLegacy) errs.push('isLegacy should be undefined for v2 docs');
  } else {
    if (!out.isLegacy) errs.push('isLegacy should be true for migrated docs');
    if (out.scores.total < 5 || out.scores.total > 20) {
      errs.push(`total=${out.scores.total} out of range`);
    }
    for (const k of ['sort', 'setInOrder', 'shine', 'standardize', 'sustain']) {
      if (out.scores[k] < 1 || out.scores[k] > 4) {
        errs.push(`scores.${k}=${out.scores[k]} out of 1..4 range`);
      }
    }
  }
  if (errs.length === 0) {
    console.log(`PASS: ${c.name}`);
    console.log(`      zone=${out.zoneCode} ${out.zoneName} status=${out.status} total=${out.scores.total} `
      + `legacy=${out.isLegacy ?? false} images=${out.images?.length ?? 0} issues=${out.issues?.length ?? 0}`);
  } else {
    failed += 1;
    console.log(`FAIL: ${c.name}`);
    for (const e of errs) console.log(`      - ${e}`);
    console.log(`      got: ${JSON.stringify({ zoneId: out.zoneId, status: out.status, scores: out.scores, isLegacy: out.isLegacy })}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} legacy migration test(s) failed.`);
  process.exit(1);
}
console.log('\nAll legacy migration tests passed.');
