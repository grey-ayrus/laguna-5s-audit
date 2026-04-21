import { useMemo, useState } from 'react';
import './AnnotatedImage.css';

const SEVERITY_COLORS = {
  critical: '#dc2626',
  moderate: '#f97316',
  minor: '#facc15',
};

function colorFor(issue) {
  if (issue.color) return issue.color;
  return SEVERITY_COLORS[issue.severity] || SEVERITY_COLORS.moderate;
}

function boxStyle(box, color) {
  const [x, y, w, h] = box;
  return {
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: `${w * 100}%`,
    height: `${h * 100}%`,
    borderColor: color,
    boxShadow: `0 0 0 1px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.35)`,
  };
}

function labelStyle(box, color) {
  const [x, y] = box;
  const onTop = y < 0.12;
  return {
    left: `${x * 100}%`,
    top: onTop ? `calc(${y * 100}% + 4px)` : `calc(${y * 100}% - 4px)`,
    transform: onTop ? 'translateY(0)' : 'translateY(-100%)',
    background: color,
  };
}

/**
 * Wraps an image in a relatively-positioned container and draws absolutely-
 * positioned boxes + labels for the supplied issues/highlights.
 *
 * `imageIndex` identifies WHICH capture this wrapper is rendering so we only
 * show annotations that target that image.
 */
export default function AnnotatedImage({
  src,
  alt,
  imageIndex = 0,
  issues = [],
  highlights = [],
  defaultVisible = true,
  showToggle = true,
  className = '',
}) {
  const [visible, setVisible] = useState(defaultVisible);

  const issuesForImage = useMemo(
    () => (issues || []).filter((i) => (i.imageIndex ?? i.image_index ?? 0) === imageIndex && Array.isArray(i.box) && i.box.length === 4),
    [issues, imageIndex],
  );
  const highlightsForImage = useMemo(
    () => (highlights || []).filter((h) => (h.imageIndex ?? h.image_index ?? 0) === imageIndex && Array.isArray(h.box) && h.box.length === 4),
    [highlights, imageIndex],
  );

  const totalAnnotations = issuesForImage.length + highlightsForImage.length;
  const hasAnnotations = totalAnnotations > 0;

  return (
    <div className={`annotated-image ${className}`.trim()}>
      <div className="annotated-image-canvas">
        <img src={src} alt={alt} />
        {visible && hasAnnotations && (
          <div className="annotated-image-overlay" aria-hidden="false">
            {highlightsForImage.map((h, idx) => (
              <div
                key={`h-${idx}`}
                className="annotated-box annotated-box-good"
                style={boxStyle(h.box, '#16a34a')}
                title={h.label}
              >
                <span className="annotated-box-label" style={labelStyle(h.box, '#16a34a')}>
                  OK: {h.label}
                </span>
              </div>
            ))}
            {issuesForImage.map((i, idx) => {
              const color = colorFor(i);
              return (
                <div
                  key={`i-${idx}`}
                  className={`annotated-box annotated-box-${i.severity || 'moderate'}`}
                  style={boxStyle(i.box, color)}
                  title={`${(i.severity || 'moderate').toUpperCase()}: ${i.label}`}
                >
                  <span className="annotated-box-label" style={labelStyle(i.box, color)}>
                    {(i.severity || 'moderate').toUpperCase()}: {i.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {showToggle && hasAnnotations && (
        <div className="annotated-image-controls">
          <button
            type="button"
            className="annotated-toggle-btn"
            onClick={() => setVisible((v) => !v)}
            aria-pressed={visible}
          >
            {visible ? 'Hide annotations' : 'Show annotations'}
          </button>
          <span className="annotated-legend">
            <span className="annotated-legend-dot" style={{ background: '#dc2626' }} /> Critical
            <span className="annotated-legend-dot" style={{ background: '#f97316' }} /> Moderate
            <span className="annotated-legend-dot" style={{ background: '#facc15' }} /> Minor
            <span className="annotated-legend-dot" style={{ background: '#16a34a' }} /> OK
          </span>
        </div>
      )}
    </div>
  );
}
