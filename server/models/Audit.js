import mongoose from 'mongoose';

const issueSchema = new mongoose.Schema({
  s: { type: String, enum: ['sort', 'setInOrder', 'shine', 'standardize', 'sustain'], required: true },
  label: { type: String, required: true },
  severity: { type: String, enum: ['minor', 'moderate', 'critical'], default: 'moderate' },
  tag: { type: String },
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

  images: [{
    original: { type: String, required: true },
    annotated: { type: String, default: null },
  }],

  scores: {
    sort:        { type: Number, required: true, min: 1, max: 4 },
    setInOrder:  { type: Number, required: true, min: 1, max: 4 },
    shine:       { type: Number, required: true, min: 1, max: 4 },
    standardize: { type: Number, required: true, min: 1, max: 4 },
    sustain:     { type: Number, required: true, min: 1, max: 4 },
    total:       { type: Number, required: true, min: 5, max: 20 },
  },

  issues: { type: [issueSchema], default: [] },
  actionPoints: { type: [String], default: [] },
  summary: { type: String, default: '' },
  remarks: { type: String, default: '' },
  status: { type: String, enum: ['Green', 'Yellow', 'Red'], required: true },

  createdAt: { type: Date, default: Date.now, index: true },
});

auditSchema.index({ zoneId: 1, createdAt: -1 });

export default mongoose.model('Audit', auditSchema);
