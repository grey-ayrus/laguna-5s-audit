import React, { useCallback, useEffect, useRef, useState } from 'react';
import './CameraCapture.css';

/**
 * Full-screen modal that opens the device camera via getUserMedia, lets the user
 * flip between front/back cameras, take a snapshot, retake, and commit.
 *
 * On commit it calls `onCapture(file, dataUrl)` with a JPEG File the parent can
 * feed straight into the same pipeline the upload-input uses. Closes on `Esc`.
 */
function CameraCapture({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const [facingMode, setFacingMode] = useState('environment');
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startStream = useCallback(async (mode) => {
    stopStream();
    setReady(false);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: mode },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setReady(true);
    } catch (err) {
      console.error('camera start failed', err);
      setError(err?.message || 'Unable to access camera. Please grant permission and try again.');
    }
  }, [stopStream]);

  useEffect(() => {
    startStream(facingMode);
    return stopStream;
  }, [facingMode, startStream, stopStream]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const takeSnapshot = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    const w = v.videoWidth || 1280;
    const h = v.videoHeight || 720;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, w, h);
    const dataUrl = c.toDataURL('image/jpeg', 0.92);
    setSnapshot(dataUrl);
  };

  const retake = () => setSnapshot(null);

  const usePhoto = async () => {
    if (!snapshot) return;
    setBusy(true);
    try {
      const res = await fetch(snapshot);
      const blob = await res.blob();
      const file = new File([blob], `camera_${Date.now()}.jpg`, { type: 'image/jpeg' });
      onCapture?.(file, snapshot);
      onClose?.();
    } finally {
      setBusy(false);
    }
  };

  const flip = () => setFacingMode((m) => (m === 'environment' ? 'user' : 'environment'));

  return (
    <div className="camera-modal" role="dialog" aria-modal="true" aria-label="Camera capture">
      <div className="camera-stage">
        {error ? (
          <div className="camera-error">
            <p>{error}</p>
            <button className="btn-secondary" onClick={onClose}>Close</button>
          </div>
        ) : snapshot ? (
          <img className="camera-view" src={snapshot} alt="Captured preview" />
        ) : (
          <video ref={videoRef} className="camera-view" playsInline muted />
        )}
        <canvas ref={canvasRef} className="camera-canvas" />
        {!ready && !snapshot && !error && (
          <div className="camera-loading">Starting camera…</div>
        )}
      </div>

      <div className="camera-controls">
        <button
          type="button"
          className="camera-icon-btn"
          onClick={onClose}
          aria-label="Close camera"
        >
          ✕
        </button>

        {snapshot ? (
          <>
            <button type="button" className="btn-secondary" onClick={retake} disabled={busy}>
              Retake
            </button>
            <button type="button" className="btn-primary" onClick={usePhoto} disabled={busy}>
              {busy ? 'Saving…' : 'Use photo'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="camera-shutter"
              onClick={takeSnapshot}
              disabled={!ready}
              aria-label="Take photo"
            >
              <span className="camera-shutter-inner" />
            </button>
            <button
              type="button"
              className="camera-icon-btn"
              onClick={flip}
              disabled={!ready}
              aria-label="Switch camera"
              title="Switch front/back"
            >
              ⟲
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default CameraCapture;
