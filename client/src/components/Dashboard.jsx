import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, PieChart, Pie, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell, ResponsiveContainer,
} from 'recharts';
import axios from 'axios';
import InstallPrompt from './InstallPrompt';
import './Dashboard.css';

const STATUS_COLORS = { Green: '#16a34a', Yellow: '#d97706', Red: '#dc2626' };

const statusBadgeClass = (status) => {
  if (status === 'Green') return 'badge badge-green';
  if (status === 'Yellow') return 'badge badge-yellow';
  return 'badge badge-red';
};

function Dashboard() {
  const navigate = useNavigate();
  const [zones, setZones] = useState([]);
  const [audits, setAudits] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filterZone, setFilterZone] = useState('');
  const [deletingIds, setDeletingIds] = useState(() => new Set());

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
      try {
        const statsRes = await axios.get('/api/audits/stats');
        setStats(statsRes.data.stats || null);
      } catch (err) { console.warn('Stats refresh after delete failed', err); }
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const z = await axios.get('/api/audits/zones');
        if (!cancelled) setZones(z.data.zones || []);
      } catch (err) { console.error('Failed to load zones', err); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const params = filterZone ? { zoneId: filterZone } : {};
        const [auditRes, statsRes] = await Promise.all([
          axios.get('/api/audits', { params }),
          axios.get('/api/audits/stats'),
        ]);
        if (cancelled) return;
        setAudits(auditRes.data.audits || []);
        setStats(statsRes.data.stats || null);
      } catch (err) {
        console.error('Failed to load dashboard data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filterZone]);

  const chartData = useMemo(() => {
    if (!stats) return { barData: [], pieData: [], trendData: [] };
    const barData = [...stats.zoneStats]
      .sort((a, b) => b.averageScore - a.averageScore)
      .map((z) => ({
        zone: z.zoneCode,
        score: Math.round(z.averageScore * 10) / 10,
        zoneName: z.zoneName,
      }));
    const pieData = (stats.statusDistribution || []).map((s) => ({ name: s.status, value: s.count }));
    const trendData = (stats.trendData || []).map((t) => ({
      date: t.date,
      score: Math.round(t.averageScore * 10) / 10,
    }));
    return { barData, pieData, trendData };
  }, [stats]);

  if (loading) return <div className="container loading">Loading dashboard...</div>;

  return (
    <div className="container">
      <div className="dashboard-header">
        <div>
          <h2>5S Audit Dashboard</h2>
          <p className="dashboard-subtitle">
            AI-powered, zone-aware 5S monitoring across the Laguna Doddaballapura plant.
          </p>
        </div>
        <button className="btn-primary" onClick={() => navigate('/new-audit')}>
          + New Audit
        </button>
      </div>

      <InstallPrompt />

      {stats && (
        <div className="stats-summary">
          <div className="stat-card">
            <h3>Total Audits</h3>
            <div className="stat-value">{stats.totalAudits}</div>
          </div>
          <div className="stat-card">
            <h3>Zones Audited</h3>
            <div className="stat-value">{stats.zonesAudited} <span className="stat-sub">/ {stats.zonesTotal}</span></div>
          </div>
          <div className="stat-card green">
            <h3>Green</h3>
            <div className="stat-value">{chartData.pieData.find((d) => d.name === 'Green')?.value || 0}</div>
          </div>
          <div className="stat-card yellow">
            <h3>Yellow</h3>
            <div className="stat-value">{chartData.pieData.find((d) => d.name === 'Yellow')?.value || 0}</div>
          </div>
          <div className="stat-card red">
            <h3>Red</h3>
            <div className="stat-value">{chartData.pieData.find((d) => d.name === 'Red')?.value || 0}</div>
          </div>
        </div>
      )}

      {(stats?.bestZone || stats?.worstZone) && (
        <div className="best-worst">
          {stats.bestZone && (
            <div className="best-worst-card best">
              <span className="badge badge-green">Best zone</span>
              <h3>{stats.bestZone.zoneCode} · {stats.bestZone.zoneName}</h3>
              <p>Avg score <strong>{Math.round(stats.bestZone.averageScore * 10) / 10}/20</strong> over {stats.bestZone.count} audit(s)</p>
            </div>
          )}
          {stats.worstZone && stats.bestZone?.zoneId !== stats.worstZone.zoneId && (
            <div className="best-worst-card worst">
              <span className="badge badge-red">Needs attention</span>
              <h3>{stats.worstZone.zoneCode} · {stats.worstZone.zoneName}</h3>
              <p>Avg score <strong>{Math.round(stats.worstZone.averageScore * 10) / 10}/20</strong> over {stats.worstZone.count} audit(s)</p>
            </div>
          )}
        </div>
      )}

      <div className="charts-grid">
        <div className="chart-container">
          <h3>Zone-wise Average Scores (out of 20)</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData.barData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="zone" angle={-45} textAnchor="end" height={70} interval={0} />
              <YAxis domain={[0, 20]} />
              <Tooltip
                formatter={(value, _name, p) => [`${value}/20`, p?.payload?.zoneName]}
                contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0' }}
              />
              <Bar dataKey="score" fill="#1e3c72" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-container">
          <h3>Compliance Distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={chartData.pieData} cx="50%" cy="50%" outerRadius={90}
                dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                {chartData.pieData.map((entry, i) => (
                  <Cell key={i} fill={STATUS_COLORS[entry.name] || '#64748b'} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 8 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-container full-width">
          <h3>Average Score Trend (last 30 days)</h3>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData.trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="date" />
              <YAxis domain={[0, 20]} />
              <Tooltip contentStyle={{ borderRadius: 8 }} />
              <Legend />
              <Line type="monotone" dataKey="score" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="audits-section">
        <div className="section-header">
          <h3>Recent Audits</h3>
          <select
            value={filterZone}
            onChange={(e) => setFilterZone(e.target.value)}
            className="filter-select"
          >
            <option value="">All zones</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
            ))}
          </select>
        </div>

        <div className="audits-grid">
          {audits.length === 0 ? (
            <div className="no-audits">
              No audits yet for this filter. Click <strong>+ New Audit</strong> to start.
            </div>
          ) : (
            audits.map((audit) => {
              const isDeleting = deletingIds.has(audit._id);
              const open = () => navigate(`/audit/${audit._id}`);
              return (
                <div
                  key={audit._id}
                  className={`audit-card ${isDeleting ? 'audit-card-deleting' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
                  }}
                >
                  <div className="audit-card-header">
                    <div>
                      <div className="audit-card-zone-code">{audit.zoneCode}</div>
                      <h4>{audit.zoneName}</h4>
                    </div>
                    <div className="audit-card-header-right">
                      <span className={statusBadgeClass(audit.status)}>{audit.status}</span>
                      <button
                        type="button"
                        className="btn-danger audit-card-delete"
                        disabled={isDeleting}
                        aria-label={`Delete audit ${audit.zoneCode} ${audit.zoneName}`}
                        onClick={(e) => handleDeleteAudit(e, audit)}
                      >
                        {isDeleting ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                  <div className="audit-score">
                    <div className="score-circle" style={{ borderColor: STATUS_COLORS[audit.status] || '#94a3b8' }}>
                      <span className="score-value">{audit.scores?.total ?? 0}</span>
                      <span className="score-label">/ 20</span>
                    </div>
                  </div>
                  <div className="audit-details-small">
                    {['sort', 'setInOrder', 'shine', 'standardize', 'sustain'].map((s) => (
                      <div className="detail-row" key={s}>
                        <span>{s === 'setInOrder' ? 'Set in Order' : s.charAt(0).toUpperCase() + s.slice(1)}</span>
                        <span>{audit.scores?.[s] ?? 0}/4</span>
                      </div>
                    ))}
                  </div>
                  <div className="audit-meta-row">
                    <span className="audit-category">{audit.zoneCategory}</span>
                    <span className="audit-date">{new Date(audit.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
