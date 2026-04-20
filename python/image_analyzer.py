"""
Flask micro-service that powers the Laguna 5S audit AI engine.

Endpoints:
  POST /analyze   -> run YOLO + OpenCV + rule engine on 1..4 images
  GET  /health    -> liveness probe

Request body for /analyze:
  {
    "zoneId":  "zone-14",          # required
    "images":  ["data:image/...;base64,..."  , ...],   # 1..4 entries
    "history": [ { previous audit summary }, ... ]     # optional, newest first
  }

Response:
  {
    "scores":        {sort,setInOrder,shine,standardize,sustain,total},
    "status":        "Green" | "Yellow" | "Red",
    "issues":        [...],
    "issuesByS":     {...},
    "actionPoints":  [...],
    "summary":       "...",
    "remarks":       "...",
    "annotations":   [...],
    "annotatedImages": ["data:image/jpeg;base64,...", ...]   # one per input image
  }
"""
from __future__ import annotations

import base64
import io
import logging
import os
from typing import Any, Dict, List

import cv2
import numpy as np
from flask import Flask, jsonify, request
from PIL import Image

from detector import detect_all, annotate
from rules import evaluate

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("laguna-5s-engine")

app = Flask(__name__)

MAX_IMAGES = 4


def _decode_data_url(data_url: str) -> np.ndarray:
    """Accept either a full data: URL or a raw base64 string and return BGR."""
    if not data_url:
        raise ValueError("Empty image payload")
    payload = data_url.split(",", 1)[1] if "," in data_url else data_url
    raw = base64.b64decode(payload)
    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def _encode_jpeg(image_bgr: np.ndarray) -> str:
    """BGR ndarray -> base64 data URL (JPEG)."""
    ok, buf = cv2.imencode(".jpg", image_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise RuntimeError("Failed to JPEG-encode annotated image")
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


@app.route("/analyze", methods=["POST"])
def analyze():
    try:
        data = request.get_json(force=True, silent=False)
        if not data:
            return jsonify({"error": "Missing JSON body"}), 400

        zone_id = data.get("zoneId")
        if not zone_id:
            return jsonify({"error": "zoneId is required"}), 400

        images = data.get("images") or []
        if not isinstance(images, list) or not 1 <= len(images) <= MAX_IMAGES:
            return jsonify({
                "error": f"Provide between 1 and {MAX_IMAGES} images in 'images'"
            }), 400

        history = data.get("history") or []

        decoded: List[np.ndarray] = []
        for raw in images:
            decoded.append(_decode_data_url(raw))

        all_detections: List[Dict[str, Any]] = []
        per_image_metrics: List[Dict[str, Any]] = []
        for idx, img in enumerate(decoded):
            result = detect_all(img, idx)
            all_detections.extend(result["detections"])
            per_image_metrics.append(result["metrics"])

        evaluation = evaluate(
            zone_id=zone_id,
            detections=all_detections,
            per_image_metrics=per_image_metrics,
            history=history,
        )

        annotated_b64: List[str] = []
        for idx, img in enumerate(decoded):
            issues_for_image = [i for i in evaluation["issues"] if i.get("image_index") == idx]
            annotated = annotate(img, issues_for_image)
            annotated_b64.append(_encode_jpeg(annotated))

        evaluation["annotatedImages"] = annotated_b64
        return jsonify(evaluation)

    except Exception as exc:
        logger.exception("Analysis failed: %s", exc)
        return jsonify({"error": str(exc)}), 500


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "OK", "service": "laguna-5s-engine"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
