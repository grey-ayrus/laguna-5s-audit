import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  PROVIDERS,
  getProvider,
  getAiSettings,
  setAiSettings,
  clearAiSettings,
  maskKey,
} from '../lib/aiSettings';
import './Settings.css';

function Settings() {
  const navigate = useNavigate();
  const initial = getAiSettings();

  const [providerId, setProviderId] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [showKey, setShowKey] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const provider = useMemo(() => getProvider(providerId), [providerId]);
  const needsKey = provider.needsKey;

  const onProviderChange = (id) => {
    const next = getProvider(id);
    setProviderId(next.id);
    setModel(next.models[0].id);
    setTestResult(null);
  };

  const onSave = () => {
    setAiSettings({ provider: provider.id, model, apiKey: apiKey.trim() });
    setSavedAt(new Date());
  };

  const onReset = () => {
    clearAiSettings();
    const d = getAiSettings();
    setProviderId(d.provider);
    setModel(d.model);
    setApiKey('');
    setSavedAt(new Date());
    setTestResult(null);
  };

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await axios.get('/api/ai/test', {
        params: { provider: provider.id, model, key: apiKey.trim() || undefined },
        timeout: 20000,
      });
      setTestResult({ ok: !!r.data?.ok, ...r.data });
    } catch (err) {
      setTestResult({
        ok: false,
        error: err.response?.data?.error || err.message || 'Unknown error',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="container">
      <div className="settings-header">
        <div>
          <h2>AI &amp; Camera Settings</h2>
          <p className="settings-subtitle">
            Pick the vision model used for new audits. Keys are stored only in this browser.
          </p>
        </div>
        <button className="btn-secondary" onClick={() => navigate('/')}>← Dashboard</button>
      </div>

      <div className="settings-card">
        <h3>Vision Provider</h3>
        <div className="provider-list">
          {PROVIDERS.map((p) => (
            <label
              key={p.id}
              className={`provider-option ${providerId === p.id ? 'active' : ''}`}
            >
              <input
                type="radio"
                name="provider"
                value={p.id}
                checked={providerId === p.id}
                onChange={() => onProviderChange(p.id)}
              />
              <div>
                <div className="provider-label">{p.label}</div>
                <div className="provider-desc">{p.description}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="settings-row">
          <label>
            <span>Model</span>
            <select value={model} onChange={(e) => { setModel(e.target.value); setTestResult(null); }}>
              {provider.models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
        </div>

        {needsKey && (
          <div className="settings-row">
            <label>
              <span>API Key</span>
              <div className="key-input">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  placeholder={provider.keyHint}
                  onChange={(e) => { setApiKey(e.target.value); setTestResult(null); }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <small className="settings-hint">
                Stored only in this browser (localStorage). Never sent anywhere except the provider you selected.
                {provider.keyUrl && (
                  <> · <a href={provider.keyUrl} target="_blank" rel="noreferrer">Get a key</a></>
                )}
                {apiKey && !showKey && <> · Preview: <code>{maskKey(apiKey)}</code></>}
              </small>
            </label>
          </div>
        )}

        <div className="settings-actions">
          <button className="btn-secondary" onClick={onReset}>Reset</button>
          <button
            className="btn-secondary"
            onClick={onTest}
            disabled={testing || (needsKey && !apiKey.trim())}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            className="btn-primary"
            onClick={onSave}
            disabled={needsKey && !apiKey.trim()}
          >
            Save
          </button>
        </div>

        {savedAt && (
          <div className="settings-saved">
            Saved at {savedAt.toLocaleTimeString()}. New audits will use this provider.
          </div>
        )}

        {testResult && (
          <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
            {testResult.ok ? (
              <>
                <strong>Connection OK</strong>
                {typeof testResult.latencyMs === 'number' && <> — {testResult.latencyMs} ms</>}
              </>
            ) : (
              <>
                <strong>Connection failed</strong>
                {testResult.error ? <> — {testResult.error}</> : null}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default Settings;
