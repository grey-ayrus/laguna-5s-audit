import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import InstallPrompt from './InstallPrompt';
import './ZoneHome.css';

const STATUS_COLOR = { Green: '#16a34a', Yellow: '#d97706', Red: '#dc2626' };

function statusBadgeClass(status) {
  if (status === 'Green') return 'badge badge-green';
  if (status === 'Yellow') return 'badge badge-yellow';
  return 'badge badge-red';
}

function formatScore(audit) {
  const f = Number(audit?.scores?.totalFinal);
  if (Number.isFinite(f)) return f.toFixed(2);
  // Very old audits that pre-date totalFinal: fall back to an estimate.
  const total = Number(audit?.scores?.total) || 0;
  const imageCount = Math.max(1, Number(audit?.scores?.imageCount) || 1);
  return ((total / (180 * imageCount)) * 10).toFixed(2);
}

function zoneNumber(zoneId) {
  const m = /^zone-(\d+)$/.exec(zoneId || '');
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

function ZoneHome() {
  const navigate = useNavigate();
  const [zones, setZones] = useState([]);
  const [audits, setAudits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deletingIds, setDeletingIds] = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [zoneRes, auditRes] = await Promise.all([
          axios.get('/api/audits/zones'),
          axios.get('/api/audits'),
        ]);
        if (cancelled) return;
        setZones(zoneRes.data.zones || []);
        setAudits(auditRes.data.audits || []);
      } catch (err) {
        console.error('Failed to load zones', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Pre-compute the most recent audit per zone for the "last score" badge.
  const lastByZone = useMemo(() => {
    const map = new Map();
    for (const a of audits) {
      const existing = map.get(a.zoneId);
      if (!existing || new Date(a.createdAt) > new Date(existing.createdAt)) {
        map.set(a.zoneId, a);
      }
    }
    return map;
  }, [audits]);

  const sortedZones = useMemo(() => {
    return [...zones].sort((a, b) => zoneNumber(a.id) - zoneNumber(b.id));
  }, [zones]);

  const recentAudits = useMemo(() => {
    return [...audits]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 6);
  }, [audits]);

  const handleZoneClick = (zoneId) => {
    navigate(`/new-audit?zone=${encodeURIComponent(zoneId)}`);
  };

  const handleDeleteAudit = async (event, audit) => {
    event.stopPropagation();
    event.preventDefault();
    const label = `${audit.zoneCode} · ${audit.zoneName}`;
    const when = new Date(audit.createdAt).toLocaleString();
    if (!window.confirm(`Delete this audit?\n\n${label}\n${when}\n\nThis cannot be undone.`)) return;

    setDeletingIds((prev) => new Set(prev).add(audit._id));
    try {
      await axios.delete(`/api/audits/${audit._id}`);
      setAudits((prev) => prev.filter((a) => a._id !== audit._id));
    } catch (err) {
      console.error('Delete failed', err);
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

  return (
    <div className="container zone-home">
      <InstallPrompt />

      <div className="zone-home-header">
        <div>
          <h2>Start a new 5S audit</h2>
          <p className="zone-home-subtitle">
            Pick a zone below to open its audit form. Each tile shows the <strong>reference photo</strong>
            - you will be comparing today's capture to this standard image.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="zone-home-loading">Loading zones…</div>
      ) : (
        <div className="zone-grid">
          {sortedZones.map((zone) => {
            const last = lastByZone.get(zone.id);
            return (
              <button
                key={zone.id}
                type="button"
                className="zone-tile"
                onClick={() => handleZoneClick(zone.id)}
              >
                <div className="zone-tile-image">
                  {zone.referenceImage ? (
                    <img
                      src={zone.referenceImage}
                      alt={`Reference for ${zone.code}`}
                      loading="lazy"
                    />
                  ) : (
                    <div className="zone-tile-image-empty">No reference yet</div>
                  )}
                  <span className="zone-tile-number">{zoneNumber(zone.id)}</span>
                </div>
                <div className="zone-tile-body">
                  <div className="zone-tile-code">{zone.code}</div>
                  <div className="zone-tile-name">{zone.name}</div>
                  <div className="zone-tile-category">{zone.category}</div>
                  {last && (
                    <div className="zone-tile-last">
                      <span className={statusBadgeClass(last.status)}>{last.status}</span>
                      <span className="zone-tile-last-score">
                        {formatScore(last)} / 10.00
                      </span>
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {recentAudits.length > 0 && (
        <section className="recent-audits">
          <div className="recent-audits-header">
            <h3>Recent audits</h3>
            <p>Open to review, download the PDF, or delete.</p>
          </div>
          <div className="recent-audits-list">
            {recentAudits.map((a) => {
              const isDeleting = deletingIds.has(a._id);
              return (
                <div
                  key={a._id}
                  className={`recent-audit-row ${isDeleting ? 'recent-audit-row-deleting' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/audit/${a._id}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      navigate(`/audit/${a._id}`);
                    }
                  }}
                >
                  <div className="recent-audit-left">
                    <div className="recent-audit-code" style={{ borderColor: STATUS_COLOR[a.status] }}>
                      {a.zoneCode}
                    </div>
                    <div>
                      <div className="recent-audit-name">{a.zoneName}</div>
                      <div className="recent-audit-meta">
                        {new Date(a.createdAt).toLocaleString()} · {a.zoneCategory}
                      </div>
                    </div>
                  </div>
                  <div className="recent-audit-right">
                    <div className="recent-audit-score">{formatScore(a)}<span>/10.00</span></div>
                    <span className={statusBadgeClass(a.status)}>{a.status}</span>
                    <button
                      type="button"
                      className="btn-danger recent-audit-delete"
                      onClick={(event) => handleDeleteAudit(event, a)}
                      disabled={isDeleting}
                    >
                      {isDeleting ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

export default ZoneHome;
