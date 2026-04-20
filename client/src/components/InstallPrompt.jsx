import React, { useEffect, useState } from 'react';
import './InstallPrompt.css';

const DISMISSED_KEY = 'laguna.installDismissedAt';

function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
  );
}

function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports as Macintosh; look at touch as well.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function wasRecentlyDismissed() {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < 7 * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Shows an "Install app" pill on capable browsers and a one-line iOS hint on
 * iPhone/iPad Safari (which doesn't fire `beforeinstallprompt`). Auto-hides
 * when the app is already running as an installed PWA, and stays hidden for
 * 7 days once the user dismisses it.
 */
function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [iosHint, setIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(wasRecentlyDismissed());

  useEffect(() => {
    if (installed || dismissed) return undefined;

    const onBeforeInstall = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    // iOS Safari doesn't implement beforeinstallprompt; show the hint
    // explicitly once, so the user still sees the install path.
    if (isIOS()) setIosHint(true);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [installed, dismissed]);

  const onInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } finally {
      setDeferredPrompt(null);
    }
  };

  const onDismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch { /* ignore */ }
    setDismissed(true);
  };

  if (installed || dismissed) return null;

  if (deferredPrompt) {
    return (
      <div className="install-pill" role="region" aria-label="Install app">
        <span className="install-pill-text">
          <strong>Install Laguna 5S</strong>
          <span className="install-pill-sub"> — faster access, works like a native app</span>
        </span>
        <div className="install-pill-actions">
          <button type="button" className="install-btn primary" onClick={onInstallClick}>
            Install app
          </button>
          <button type="button" className="install-btn ghost" onClick={onDismiss} aria-label="Dismiss">
            ✕
          </button>
        </div>
      </div>
    );
  }

  if (iosHint) {
    return (
      <div className="install-pill ios" role="region" aria-label="Install app on iOS">
        <span className="install-pill-text">
          <strong>Install on your iPhone:</strong>
          <span className="install-pill-sub"> tap Share, then <em>Add to Home Screen</em>.</span>
        </span>
        <button type="button" className="install-btn ghost" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    );
  }

  return null;
}

export default InstallPrompt;
