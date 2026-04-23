import mongoose from 'mongoose';

const issueSchema = new mongoose.Schema({
  s: { type: String, enum: ['sort', 'setInOrder', 'shine', 'standardize', 'sustain'], required: true },
  label: { type: String, required: true },
  severity: { type: String, enum: ['minor', 'moderate', 'critical'], default: 'moderate' },
  tag: { type: String },
  imageIndex: { type: Number, default: 0 },
  // Normalised bounding box [x, y, w, h] in 0..1. Omitted when the LLM could
  // not pinpoint the defect on the capture.
  box: { type: [Number], default: undefined },
}, { _id: false });

// Good things visible in the capture. Drawn with green boxes.
const highlightSchema = new mongoose.Schema({
  label: { type: String, required: true },
  imageIndex: { type: Number, default: 0 },
  box: { type: [Number], default: undefined },
}, { _id: false });

const auditSchema = new mongoose.Schema({
  zoneId: { type: String, required: true, index: true },
  zoneCode: { type: String, required: true },
  zoneName: { type: String, required: true },
  zoneCategory: { type: String, required: true },

  // Backwards-compat with the previous /v1 schema. Filled in for legacy audits.
  legacySectionName: { type: String, default: null },

  // URL/path to the per-zone reference ("standard") image that was used to
  // score this audit. Cached on the document so the PDF and details page
  // keep rendering the same reference even if the mapping changes later.
  referenceImage: { type: String, default: null },

  images: [{
    original: { type: String, required: true },
    annotated: { type: String, default: null },
  }],

  // Each S is scored 1..36 (per image); total is the sum of the 5 S's (5..180).
  // totalFinal is the normalised display score (0.00..10.00), independent of
  // how many images the auditor uploaded, computed as:
  //   totalFinal = total / (180 * imageCount) * 10, rounded to 2 decimals.
  scores: {
    sort:        { type: Number, required: true, min: 1, max: 36 },
    setInOrder:  { type: Number, required: true, min: 1, max: 36 },
    shine:       { type: Number, required: true, min: 1, max: 36 },
    standardize: { type: Number, required: true, min: 1, max: 36 },
    sustain:     { type: Number, required: true, min: 1, max: 36 },
    total:       { type: Number, required: true, min: 5, max: 180 },
    totalFinal:  { type: Number, required: true, min: 0, max: 10 },
    imageCount:  { type: Number, required: true, min: 1, max: 4 },
  },

  issues: { type: [issueSchema], default: [] },
  highlights: { type: [highlightSchema], default: [] },
  // Short positive observations ("PPE present", "first-aid kit placed"). Shown
  // as a green checklist next to Issues Detected so strong zones still get
  // credit for what's going right.
  strengths: { type: [String], default: [] },
  actionPoints: { type: [String], default: [] },
  summary: { type: String, default: '' },
  remarks: { type: String, default: '' },
  status: { type: String, enum: ['Green', 'Yellow', 'Red'], required: true },

  createdAt: { type: Date, default: Date.now, index: true },
});

auditSchema.index({ zoneId: 1, createdAt: -1 });

export default mongoose.model('Audit', auditSchema);
