import React from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './components/Dashboard';
import NewAudit from './components/NewAudit';
import AuditDetails from './components/AuditDetails';
import Settings from './components/Settings';
import './App.css';

function App() {
  return (
    <Router>
      <div className="app">
        <header className="app-header">
          <div className="container">
            <div className="header-content">
              <div className="header-logo-section">
                <img src="/laguna-logo.svg" alt="Laguna Logo" className="header-logo" />
                <div className="header-text">
                  <h1>Laguna India Pvt Ltd</h1>
                  <p className="header-subtitle">Doddaballapura · 5S AI Audit System</p>
                </div>
              </div>
              <nav className="header-nav">
                <NavLink to="/" end>Dashboard</NavLink>
                <NavLink to="/new-audit">New Audit</NavLink>
                <NavLink to="/settings">Settings</NavLink>
              </nav>
            </div>
          </div>
        </header>

        <main>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/new-audit" element={<NewAudit />} />
            <Route path="/audit/:id" element={<AuditDetails />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>

        <footer className="app-footer">
          Laguna India Pvt Ltd © {new Date().getFullYear()} · Built for the Doddaballapura plant
        </footer>
      </div>
    </Router>
  );
}

export default App;
