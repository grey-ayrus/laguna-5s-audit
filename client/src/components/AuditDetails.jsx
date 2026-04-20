import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import './AuditDetails.css';

const STATUS_COLORS = { Green: '#16a34a', Yellow: '#d97706', Red: '#dc2626' };

const SCORE_LABELS = {
  sort: { en: 'Sort', jp: 'Seiri' },
  setInOrder: { en: 'Set in Order', jp: 'Seiton' },
  shine: { en: 'Shine', jp: 'Seiso' },
  standardize: { en: 'Standardize', jp: 'Seiketsu' },
  sustain: { en: 'Sustain', jp: 'Shitsuke' },
};

const statusBadgeClass = (status) => {
  if (status === 'Green') return 'badge badge-green';
  if (status === 'Yellow') return 'badge badge-yellow';
  return 'badge badge-red';
};

function AuditDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await axios.get(`/api/audits/${id}`);
        if (!cancelled) setAudit(r.data.audit);
      } catch (err) {
        console.error(err);
        alert('Failed to load audit');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const downloadPDF = async () => {
    if (!audit?._id) return;
    try {
      const response = await axios.get(`/api/audits/${audit._id}/pdf`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.download = `5S_Audit_${audit.zoneCode}_${new Date(audit.createdAt).toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      console.error(err);
      alert('Failed to download PDF');
    }
  };

  const handleDelete = async () => {
    if (!audit?._id || deleting) return;
    const label = `${audit.zoneCode} · ${audit.zoneName}`;
    const when = new Date(audit.createdAt).toLocaleString();
    if (!window.confirm(`Delete this audit?\n\n${label}\n${when}\n\nThis cannot be undone.`)) return;

    setDeleting(true);
    try {
      await axios.delete(`/api/audits/${audit._id}`);
      navigate('/', { replace: true });
    } catch (err) {
      console.error(err);
      const msg = err?.response?.data?.error || err.message || 'unknown error';
      alert(`Could not delete audit: ${msg}`);
      setDeleting(false);
    }
  };

  if (loading) return <div className="container loading">Loading audit details…</div>;
  if (!audit) return <div className="container">Audit not found.</div>;

  const total = audit.scores?.total ?? 0;

  return (
    <div className="container">
      <div className="details-header">
        <button className="btn-secondary" onClick={() => navigate('/')}>← Dashboard</button>
        <div className="details-header-actions">
          <button
            className="btn-danger details-header-delete"
            onClick={handleDelete}
            disabled={deleting}
            aria-label={`Delete audit ${audit.zoneCode} ${audit.zoneName}`}
          >
            {deleting ? 'Deleting…' : 'Delete audit'}
          </button>
          <button className="btn-primary" onClick={downloadPDF}>Download PDF</button>
        </div>
      </div>

      <div className="details-card">
        <div className="result-header">
          <div>
            <div className="result-zone-code">{audit.zoneCode}</div>
            <h2 className="result-zone-name">{audit.zoneName}</h2>
            <p className="result-meta">
              {audit.zoneCategory} · {new Date(audit.createdAt).toLocaleString()}
              {audit.isLegacy && <span className="legacy-pill">Legacy</span>}
            </p>
          </div>
          <div className="result-score-block">
            <div className="result-score-circle" style={{ borderColor: STATUS_COLORS[audit.status] }}>
              <span className="result-score-value">{total}</span>
              <span className="result-score-label">/ 20</span>
            </div>
            <span className={statusBadgeClass(audit.status)}>{audit.status}</span>
          </div>
        </div>

        <div className="scores-grid-v2">
          {['sort', 'setInOrder', 'shine', 'standardize', 'sustain'].map((s) => {
            const score = audit.scores?.[s] ?? 0;
            const pct = (score / 4) * 100;
            const tone = score === 4 ? 'good' : score === 3 ? 'okay' : score === 2 ? 'warn' : 'bad';
            return (
              <div className={`score-row tone-${tone}`} key={s}>
                <div className="score-row-label">
                  <span className="score-row-en">{SCORE_LABELS[s].en}</span>
                  <span className="score-row-jp">({SCORE_LABELS[s].jp})</span>
                </div>
                <div className="score-row-bar">
                  <div className="score-row-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="score-row-value">{score}/4</div>
              </div>
            );
          })}
        </div>

        {audit.summary && (
          <div className="summary-card">
            <h4>Zone Summary</h4>
            <p>{audit.summary}</p>
          </div>
        )}

        {audit.images && audit.images.length > 0 && (
          <div className="annotated-grid">
            {audit.images.map((img, idx) => {
              const src = img.annotated || img.original;
              const href = /^(https?:|data:)/i.test(src) ? src : `/${src}`;
              return (
                <figure className="annotated-card" key={idx}>
                  <img src={href} alt={`Audit image ${idx + 1}`} />
                  <figcaption>{img.annotated ? `Image ${idx + 1} · annotated` : `Image ${idx + 1}`}</figcaption>
                </figure>
              );
            })}
          </div>
        )}

        <div className="issues-card">
          <h4>Issues Detected ({audit.issues?.length || 0})</h4>
          {audit.issues && audit.issues.length > 0 ? (
            <ul className="issues-list">
              {audit.issues.map((issue, i) => (
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

        {audit.actionPoints && audit.actionPoints.length > 0 && (
          <div className="actions-card">
            <h4>Action Points</h4>
            <ol>
              {audit.actionPoints.map((a, i) => <li key={i}>{a}</li>)}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

export default AuditDetails;
