import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import CameraCapture from './CameraCapture';
import AnnotatedImage from './AnnotatedImage';
import { getAiSettings, aiPayload, getProvider } from '../lib/aiSettings';
import './NewAudit.css';

const hasMediaDevices = typeof navigator !== 'undefined'
  && !!navigator.mediaDevices
  && typeof navigator.mediaDevices.getUserMedia === 'function';

const isTouchDevice = typeof window !== 'undefined'
  && ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0);

// Small laptops can still benefit from the live webcam; desktops without touch
// don't need the "native camera" input that only mobiles wire up sensibly.
const SHOW_NATIVE_CAMERA = isTouchDevice;
const SHOW_LIVE_CAMERA = hasMediaDevices;

const MAX_IMAGES = 4;
const MIN_IMAGES = 1;

const STATUS_COLORS = { Green: '#16a34a', Yellow: '#d97706', Red: '#dc2626' };

const SCORE_LABELS = {
  sort: { en: 'Sort', jp: 'Seiri' },
  setInOrder: { en: 'Set in Order', jp: 'Seiton' },
  shine: { en: 'Shine', jp: 'Seiso' },
  standardize: { en: 'Standardize', jp: 'Seiketsu' },
  sustain: { en: 'Sustain', jp: 'Shitsuke' },
};

function statusBadgeClass(status) {
  if (status === 'Green') return 'badge badge-green';
  if (status === 'Yellow') return 'badge badge-yellow';
  return 'badge badge-red';
}

function NewAudit() {
  const navigate = useNavigate();
  const location = useLocation();
  const [zones, setZones] = useState([]);
  const [zoneFilter, setZoneFilter] = useState('');
  const [step, setStep] = useState(1);
  const [selectedZone, setSelectedZone] = useState(null);
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);

  const preselectZoneId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('zone');
  }, [location.search]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await axios.get('/api/audits/zones');
        if (!cancelled) setZones(r.data.zones || []);
      } catch (err) { console.error(err); }
    })();
    return () => { cancelled = true; };
  }, []);

  // When we arrive with ?zone=zone-X, jump straight to Step 2 once zones load.
  useEffect(() => {
    if (!preselectZoneId || !zones.length || selectedZone) return;
    const match = zones.find((z) => z.id === preselectZoneId);
    if (match) {
      setSelectedZone(match);
      setStep(2);
    }
  }, [preselectZoneId, zones, selectedZone]);

  const groupedZones = useMemo(() => {
    const filter = zoneFilter.trim().toLowerCase();
    const matched = filter
      ? zones.filter((z) =>
          z.name.toLowerCase().includes(filter) ||
          z.code.toLowerCase().includes(filter) ||
          z.category.toLowerCase().includes(filter))
      : zones;
    const groups = new Map();
    matched.forEach((z) => {
      if (!groups.has(z.category)) groups.set(z.category, []);
      groups.get(z.category).push(z);
    });
    return [...groups.entries()];
  }, [zones, zoneFilter]);

  const handleZoneSelect = (zone) => {
    setSelectedZone(zone);
    setStep(2);
  };

  const handleImagesChosen = (fileList) => {
    if (!fileList || fileList.length === 0) return;
    const remainingSlots = MAX_IMAGES - images.length;
    if (remainingSlots <= 0) {
      setError(`A maximum of ${MAX_IMAGES} images is allowed per audit.`);
      return;
    }
    const accepted = Array.from(fileList).slice(0, remainingSlots);
    accepted.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImages((prev) => [...prev, { name: file.name, dataUrl: reader.result }]);
      };
      reader.readAsDataURL(file);
    });
    setError(null);
  };

  const removeImage = (index) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAnalyze = async () => {
    if (!selectedZone) return setError('Please select a zone first.');
    if (images.length < MIN_IMAGES) return setError(`Please add at least ${MIN_IMAGES} image.`);

    const settings = getAiSettings();
    const provider = getProvider(settings.provider);
    if (provider.needsKey && !settings.apiKey) {
      return setError(`${provider.label} is selected but no API key is saved. Open Settings to add a key, or switch to Local.`);
    }

    setLoading(true);
    setError(null);
    try {
      const response = await axios.post('/api/audits', {
        zoneId: selectedZone.id,
        images: images.map((img) => img.dataUrl),
        ...aiPayload(settings),
      });
      setResult(response.data.audit);
      setStep(3);
    } catch (err) {
      console.error(err);
      const detail = err.response?.data?.error || err.message;
      setError(`Audit failed: ${detail}`);
    } finally {
      setLoading(false);
    }
  };

  const handleNewAudit = () => {
    setStep(1);
    setSelectedZone(null);
    setImages([]);
    setResult(null);
    setError(null);
  };

  const downloadPDF = async () => {
    if (!result?._id) return;
    try {
      const response = await axios.get(`/api/audits/${result._id}/pdf`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.download = `5S_Audit_${result.zoneCode}_${new Date(result.createdAt).toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      console.error('PDF download failed', err);
      alert('Failed to download PDF');
    }
  };

  const renderStep1 = () => (
    <div className="step-container">
      <div className="step-title-row">
        <div>
          <h3>Step 1 · Select a zone</h3>
          <p className="step-subtitle">Choose the area to audit. The AI will load the rules and expectations specific to that zone.</p>
        </div>
        <input
          type="search"
          className="zone-filter"
          placeholder="Search by name, code or category…"
          value={zoneFilter}
          onChange={(e) => setZoneFilter(e.target.value)}
        />
      </div>

      {groupedZones.length === 0 && (
        <div className="empty-state">No zones match your search.</div>
      )}

      {groupedZones.map(([category, list]) => (
        <div className="zone-group" key={category}>
          <h4 className="zone-group-title">{category}</h4>
          <div className="zones-grid">
            {list.map((z) => (
              <button
                type="button"
                key={z.id}
                className="zone-card"
                onClick={() => handleZoneSelect(z)}
              >
                <span className="zone-card-code">{z.code}</span>
                <span className="zone-card-name">{z.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  const renderStep2 = () => (
    <div className="step-container">
      <div className="step-title-row">
        <div>
          <h3>Step 2 · Capture or upload images</h3>
          <p className="step-subtitle">
            Add between {MIN_IMAGES} and {MAX_IMAGES} images for <strong>{selectedZone?.code} · {selectedZone?.name}</strong>.
            The AI scores how close your capture is to the reference photo on the left.
          </p>
        </div>
        <button className="btn-secondary" onClick={() => { setStep(1); setImages([]); }}>← Change zone</button>
      </div>

      {selectedZone?.referenceImage && (
        <div className="reference-panel">
          <div className="reference-panel-body">
            <img
              src={selectedZone.referenceImage}
              alt={`Reference for ${selectedZone.code}`}
              className="reference-panel-image"
            />
            <div className="reference-panel-text">
              <div className="reference-panel-label">Reference (Standard)</div>
              <h4>{selectedZone.code} · {selectedZone.name}</h4>
              <p>
                This is the target condition for this zone. Your capture below will be compared to
                this image on all 5 S's (Sort, Set in Order, Shine, Standardize, Sustain). Each S is
                scored from <strong>1 to 36</strong>, and the final score is normalised to
                a <strong>/10.00</strong> grade.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="upload-actions">
        <label className="upload-button">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => { handleImagesChosen(e.target.files); e.target.value = ''; }}
            style={{ display: 'none' }}
          />
          Upload images
        </label>
        {SHOW_NATIVE_CAMERA && (
          <label className="upload-button camera">
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => { handleImagesChosen(e.target.files); e.target.value = ''; }}
              style={{ display: 'none' }}
            />
            Capture with camera
          </label>
        )}
        {SHOW_LIVE_CAMERA && (
          <button
            type="button"
            className="upload-button live-camera"
            onClick={() => setCameraOpen(true)}
            disabled={images.length >= MAX_IMAGES}
          >
            Live camera
          </button>
        )}
        <span className="image-count">{images.length}/{MAX_IMAGES} images</span>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {images.length === 0 ? (
        <div className="upload-placeholder">
          <span className="upload-icon">+</span>
          <p>No images yet — add at least one to begin the analysis.</p>
        </div>
      ) : (
        <div className="image-preview-grid">
          {images.map((img, i) => (
            <div className="image-preview-card" key={i}>
              <img src={img.dataUrl} alt={img.name || `Image ${i + 1}`} />
              <div className="image-preview-meta">
                <span>Image {i + 1}</span>
                <button type="button" className="btn-danger" onClick={() => removeImage(i)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="step-actions">
        <button className="btn-secondary" onClick={() => navigate('/')}>Cancel</button>
        <button
          className="btn-primary"
          onClick={handleAnalyze}
          disabled={loading || images.length < MIN_IMAGES}
        >
          {loading ? 'Analysing…' : 'Run AI 5S Analysis'}
        </button>
      </div>
    </div>
  );

  const renderResult = () => {
    if (!result) return null;
    const total = result.scores?.total ?? 0;
    const imageCount = result.scores?.imageCount ?? Math.max(1, (result.images || []).length || 1);
    const finalRaw = result.scores?.totalFinal;
    const finalScore = Number.isFinite(Number(finalRaw))
      ? Number(finalRaw)
      : (total / (180 * imageCount)) * 10;
    return (
      <div className="step-container">
        <div className="result-header">
          <div>
            <div className="result-zone-code">{result.zoneCode}</div>
            <h3 className="result-zone-name">{result.zoneName}</h3>
            <p className="result-meta">
              {result.zoneCategory} · {new Date(result.createdAt).toLocaleString()}
            </p>
          </div>
          <div className="result-score-block">
            <div className="result-score-circle" style={{ borderColor: STATUS_COLORS[result.status] }}>
              <span className="result-score-value">{finalScore.toFixed(2)}</span>
              <span className="result-score-label">/ 10.00</span>
            </div>
            <span className={statusBadgeClass(result.status)}>{result.status}</span>
            <div className="result-score-breakdown">
              Raw total {total}/{180 * imageCount} · {imageCount} image{imageCount === 1 ? '' : 's'}
            </div>
          </div>
        </div>

        <div className="scores-grid-v2">
          {['sort', 'setInOrder', 'shine', 'standardize', 'sustain'].map((s) => {
            const score = result.scores?.[s] ?? 0;
            const pct = (score / 36) * 100;
            const tone = score >= 33 ? 'good' : score >= 25 ? 'okay' : score >= 17 ? 'warn' : 'bad';
            return (
              <div className={`score-row tone-${tone}`} key={s}>
                <div className="score-row-label">
                  <span className="score-row-en">{SCORE_LABELS[s].en}</span>
                  <span className="score-row-jp">({SCORE_LABELS[s].jp})</span>
                </div>
                <div className="score-row-bar">
                  <div className="score-row-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="score-row-value">{score}/36</div>
              </div>
            );
          })}
        </div>

        {result.summary && (
          <div className="summary-card">
            <h4>Zone Summary</h4>
            <p>{result.summary}</p>
          </div>
        )}

        <div className="annotated-grid">
          {(result.images || []).map((img, idx) => {
            const src = img.annotated || img.original;
            const href = /^(https?:|data:)/i.test(src) ? src : `/${src}`;
            return (
              <figure className="annotated-card" key={idx}>
                <AnnotatedImage
                  src={href}
                  alt={`Capture ${idx + 1}`}
                  imageIndex={idx}
                  issues={result.issues || []}
                  highlights={result.highlights || []}
                />
                <figcaption>
                  Image {idx + 1}
                  {(() => {
                    const issueCount = (result.issues || []).filter((i) => (i.imageIndex ?? i.image_index ?? 0) === idx && Array.isArray(i.box)).length;
                    const hlCount = (result.highlights || []).filter((h) => (h.imageIndex ?? h.image_index ?? 0) === idx && Array.isArray(h.box)).length;
                    const total = issueCount + hlCount;
                    return total > 0 ? ` · ${total} annotation${total === 1 ? '' : 's'}` : '';
                  })()}
                </figcaption>
              </figure>
            );
          })}
        </div>

        {result.strengths && result.strengths.length > 0 && (
          <div className="strengths-card">
            <h4>What's going well ({result.strengths.length})</h4>
            <ul className="strengths-list">
              {result.strengths.map((s, i) => (
                <li key={i}>
                  <span className="strength-check" aria-hidden="true">✓</span>
                  <span className="strength-text">{s}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="issues-card">
          <h4>Issues Detected ({result.issues?.length || 0})</h4>
          {result.issues && result.issues.length > 0 ? (
            <ul className="issues-list">
              {result.issues.map((issue, i) => (
                <li key={i}>
                  <span className={`severity-pill severity-${issue.severity || 'moderate'}`}>{issue.severity || 'moderate'}</span>
                  <span className="issue-s">{SCORE_LABELS[issue.s]?.en || issue.s}</span>
                  <span className="issue-text">{issue.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">No issues detected — this zone is in compliance.</p>
          )}
        </div>

        <div className="actions-card">
          <h4>Action Points</h4>
          <ol>
            {(result.actionPoints || []).map((a, i) => <li key={i}>{a}</li>)}
          </ol>
        </div>

        <div className="step-actions">
          <button className="btn-secondary" onClick={handleNewAudit}>+ New audit</button>
          <button className="btn-secondary" onClick={downloadPDF}>Download PDF</button>
          <button className="btn-primary" onClick={() => navigate('/')}>Back to zones</button>
        </div>
      </div>
    );
  };

  return (
    <div className="container">
      <div className="new-audit-header">
        <h2>New 5S Audit</h2>
        <button className="btn-secondary" onClick={() => navigate('/')}>← Zones</button>
      </div>

      <div className="stepper">
        <div className={`stepper-item ${step >= 1 ? 'active' : ''}`}>1. Zone</div>
        <div className={`stepper-item ${step >= 2 ? 'active' : ''}`}>2. Images</div>
        <div className={`stepper-item ${step >= 3 ? 'active' : ''}`}>3. Results</div>
      </div>

      {step === 1 && renderStep1()}
      {step === 2 && renderStep2()}
      {step === 3 && renderResult()}

      {cameraOpen && (
        <CameraCapture
          onClose={() => setCameraOpen(false)}
          onCapture={(file) => {
            const list = new DataTransfer();
            list.items.add(file);
            handleImagesChosen(list.files);
          }}
        />
      )}
    </div>
  );
}

export default NewAudit;
