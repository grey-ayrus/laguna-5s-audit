import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import './ZonePage.css';

const STATUS_COLOR = { Green: '#16a34a', Yellow: '#d97706', Red: '#dc2626' };

function statusBadgeClass(status) {
  if (status === 'Green') return 'badge badge-green';
  if (status === 'Yellow') return 'badge badge-yellow';
  return 'badge badge-red';
}

function formatScore(audit) {
  const f = Number(audit?.scores?.totalFinal);
  if (Number.isFinite(f)) return f.toFixed(2);
  const total = Number(audit?.scores?.total) || 0;
  const imageCount = Math.max(1, Number(audit?.scores?.imageCount) || 1);
  return ((total / (180 * imageCount)) * 10).toFixed(2);
}

function formatDate(d) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

export default function ZonePage() {
  const { zoneId } = useParams();
  const navigate = useNavigate();
  const [zone, setZone] = useState(null);
  const [audits, setAudits] = useState([]);
  const [limit, setLimit] = useState(3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deletingIds, setDeletingIds] = useState(() => new Set());

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const { data } = await axios.get(`/api/audits/zones/${encodeURIComponent(zoneId)}/history`);
      setZone(data.zone);
      setAudits(Array.isArray(data.audits) ? data.audits : []);
      if (Number.isFinite(data.limit)) setLimit(data.limit);
    } catch (err) {
      console.error('Zone history load failed', err);
      setError(err?.response?.data?.error || err.message || 'Failed to load zone');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!zoneId) return;
    load();
     
  }, [zoneId]);

  const sortedAudits = useMemo(
    () => [...audits].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [audits],
  );

  const handleDelete = async (event, audit) => {
    event.stopPropagation();
    event.preventDefault();
    const when = formatDate(audit.createdAt);
    if (!window.confirm(`Delete this audit?\n\n${zone?.code} · ${zone?.name}\n${when}\n\nThis cannot be undone.`)) return;
    setDeletingIds((prev) => new Set(prev).add(audit._id));
    try {
      await axios.delete(`/api/audits/${audit._id}`);
      setAudits((prev) => prev.filter((a) => a._id !== audit._id));
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'unknown error';
      alert(`Could not delete audit: ${msg}`);
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(audit._id);
        return next;
      });
    }
  };

  const handleStartNew = () => {
    navigate(`/new-audit?zone=${encodeURIComponent(zoneId)}`);
  };

  return (
    <div className="container zone-page">
      <div className="zone-page-breadcrumb">
        <Link to="/">← All zones</Link>
      </div>

      {loading ? (
        <div className="zone-page-loading">Loading zone…</div>
      ) : error ? (
        <div className="zone-page-error">{error}</div>
      ) : zone && (
        <>
          <header className="zone-page-header">
            <div className="zone-page-header-image">
              {zone.referenceImage ? (
                <img src={zone.referenceImage} alt={`Reference for ${zone.code}`} />
              ) : (
                <div className="zone-page-header-image-empty">No reference photo uploaded</div>
              )}
            </div>
            <div className="zone-page-header-info">
              <div className="zone-page-eyebrow">{zone.category}</div>
              <h2>{zone.code} · {zone.name}</h2>
              <p className="zone-page-desc">
                Start a new audit below to compare today's capture against the reference photo,
                or review the last {limit} audits recorded for this zone.
              </p>
              <div className="zone-page-cta">
                <button type="button" className="btn-primary" onClick={handleStartNew}>
                  + Start a new audit
                </button>
              </div>
            </div>
          </header>

          <section className="zone-history">
            <div className="zone-history-header">
              <h3>Last {limit} audits</h3>
              <span className="zone-history-count">{sortedAudits.length} saved</span>
            </div>

            {sortedAudits.length === 0 ? (
              <div className="zone-history-empty">
                <p>No audits recorded for this zone yet.</p>
                <p className="zone-history-empty-hint">Run your first audit to start building history.</p>
              </div>
            ) : (
              <ul className="zone-history-list">
                {sortedAudits.map((a) => {
                  const isDeleting = deletingIds.has(a._id);
                  const thumb = a.images?.[0]?.original || a.images?.[0]?.annotated || null;
                  const issuesCount = Array.isArray(a.issues) ? a.issues.length : 0;
                  return (
                    <li
                      key={a._id}
                      className={`zone-history-item ${isDeleting ? 'zone-history-item-deleting' : ''}`}
                      onClick={() => navigate(`/audit/${a._id}`)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          navigate(`/audit/${a._id}`);
                        }
                      }}
                    >
                      <div className="zone-history-thumb">
                        {thumb ? (
                          <img src={thumb} alt={`Audit on ${formatDate(a.createdAt)}`} />
                        ) : (
                          <div className="zone-history-thumb-empty">no image</div>
                        )}
                      </div>
                      <div className="zone-history-body">
                        <div className="zone-history-top">
                          <span className={statusBadgeClass(a.status)}>{a.status}</span>
                          <span
                            className="zone-history-score"
                            style={{ color: STATUS_COLOR[a.status] || 'inherit' }}
                          >
                            {formatScore(a)}<span className="zone-history-score-denom">/10</span>
                          </span>
                        </div>
                        <div className="zone-history-meta">{formatDate(a.createdAt)}</div>
                        <div className="zone-history-detail">
                          {issuesCount > 0
                            ? `${issuesCount} issue${issuesCount === 1 ? '' : 's'} flagged`
                            : 'No issues flagged'}
                          {a.engine && <span> · {a.engine}</span>}
                        </div>
                      </div>
                      <div className="zone-history-actions">
                        <Link
                          to={`/audit/${a._id}`}
                          className="zone-history-view"
                          onClick={(ev) => ev.stopPropagation()}
                        >
                          View →
                        </Link>
                        <button
                          type="button"
                          className="btn-danger zone-history-delete"
                          onClick={(ev) => handleDelete(ev, a)}
                          disabled={isDeleting}
                        >
                          {isDeleting ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
