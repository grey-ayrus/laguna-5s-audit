"""
Object detection module for the Laguna 5S audit system.

Combines two complementary signals:
  1. YOLOv8 (lazy-loaded, COCO classes) - reliable detection of people,
     furniture, electronics, food items, bags, ...
  2. OpenCV heuristics                    - texture / colour anomalies that
     YOLO cannot see: dirt patches, oil stains, fabric bundles, fabric scrap,
     stray threads, clutter density, edge density, ...

Output is a single normalised list of "detections", each shaped like:

    {
        "label":       str,    # e.g. "fabric_scrap_floor", "fabric_roll"
        "category":    str,    # one of: object | waste | stain | structural
        "confidence":  float,  # 0..1
        "box":         [x, y, w, h] in pixels,
        "image_index": int,    # which uploaded image this came from
    }

The rule engine in `rules.py` then turns this neutral detection list into
zone-specific 5S issues + scores.

Heuristics design notes (April 2026 precision pass):
  - Real factory photos contain large neat stacks of folded fabric on racks.
    Earlier iterations of `_detect_floor_scrap` flagged those as waste because
    the heuristic only looked at edge density. We now require *all* of:
        * patch is genuinely small (<= 3% of floor area)
        * shape is wispy / irregular (not rectangular like a folded stack)
        * patch is not inside a structured rack region (high orthogonal lines)
        * patch tone differs strongly from the surrounding floor mean
  - The dark-patch detector previously fired on shadows under shelves. We now
    require: low saturation, near-elliptical shape, smooth interior texture,
    and reject thin horizontal strips that match shelf/floor seam shadows.
  - A new positive `fabric_bundle` detector recognises stacks of folded
    fabric on racks (compact bright regions with many parallel fold lines)
    and emits them as `fabric_roll` (allowed inventory) so they count as
    expected stock rather than waste.
"""
from __future__ import annotations

import logging
from typing import List, Dict, Any, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_YOLO_MODEL = None
_YOLO_FAILED = False


def _load_yolo():
    """Load YOLOv8n on demand. Returns the model or None if unavailable."""
    global _YOLO_MODEL, _YOLO_FAILED
    if _YOLO_MODEL is not None or _YOLO_FAILED:
        return _YOLO_MODEL

    try:
        from ultralytics import YOLO

        # YOLOv8n is the smallest variant (~6 MB weights, ~80 MB total install).
        # Auto-downloaded on first run, cached forever after.
        _YOLO_MODEL = YOLO("yolov8n.pt")
        logger.info("YOLOv8n loaded successfully")
    except Exception as exc:  # pragma: no cover - depends on environment
        logger.warning("YOLOv8 unavailable, falling back to OpenCV-only mode: %s", exc)
        _YOLO_FAILED = True
        _YOLO_MODEL = None
    return _YOLO_MODEL


# Mapping from raw COCO labels to the vocabulary our zones config uses.
# Anything not in this map is dropped (we don't care about cars in the canteen).
COCO_TO_FACTORY = {
    "person": "person",
    "chair": "chair",
    "couch": "bench",
    "bench": "bench",
    "dining table": "table",
    "tv": "monitor",
    "laptop": "laptop",
    "mouse": "mouse",
    "keyboard": "keyboard",
    "cell phone": "phone",
    "book": "book",
    "clock": "sign",
    "vase": "plant",
    "potted plant": "plant",
    "cup": "cup",
    "bottle": "bottle_unattended",
    "bowl": "plate",
    "fork": "utensil",
    "knife": "utensil",
    "spoon": "utensil",
    "banana": "food",
    "apple": "food",
    "sandwich": "food",
    "orange": "food",
    "broccoli": "food",
    "carrot": "food",
    "hot dog": "food",
    "pizza": "food",
    "donut": "food",
    "cake": "food",
    "backpack": "bag",
    "handbag": "bag",
    "suitcase": "bag",
    "umbrella": "bag",
    "car": "vehicle",
    "truck": "vehicle",
    "motorcycle": "vehicle",
    "refrigerator": "cabinet",
    "microwave": "cabinet",
    "oven": "cabinet",
    "sink": "sink",
    "toilet": "sink",
    "bed": "bed",
    "scissors": "tool_loose",
    "remote": "tool_loose",
    "teddy bear": "toy",
}


def detect_yolo(image: np.ndarray, image_index: int) -> List[Dict[str, Any]]:
    """Run YOLOv8 inference and translate hits into the factory vocabulary."""
    model = _load_yolo()
    if model is None:
        return []

    try:
        # imgsz=640 is a sweet spot between accuracy and CPU speed.
        results = model.predict(image, imgsz=640, verbose=False, conf=0.30)
    except Exception as exc:  # pragma: no cover
        logger.exception("YOLO inference failed: %s", exc)
        return []

    detections: List[Dict[str, Any]] = []
    for r in results:
        names = r.names
        for box in r.boxes:
            cls_id = int(box.cls[0])
            coco_label = names.get(cls_id, str(cls_id))
            factory_label = COCO_TO_FACTORY.get(coco_label)
            if not factory_label:
                continue

            xyxy = box.xyxy[0].tolist()
            x1, y1, x2, y2 = [int(v) for v in xyxy]
            detections.append({
                "label": factory_label,
                "raw_label": coco_label,
                "category": "object",
                "confidence": float(box.conf[0]),
                "box": [x1, y1, x2 - x1, y2 - y1],
                "image_index": image_index,
            })
    return detections


# ---------------------------------------------------------------------------
# Shared per-image structural map (used by multiple heuristics).
# ---------------------------------------------------------------------------

def _build_structure_mask(gray: np.ndarray) -> np.ndarray:
    """
    Build a binary mask of "structured rack-like regions" - places where strong
    orthogonal line patterns dominate. We use this to *exclude* dark patches
    and floor-scrap candidates that fall inside racks / shelves / equipment.
    """
    edges = cv2.Canny(gray, 60, 180)

    # Detect long horizontal & vertical lines as proxies for racks / shelves.
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (35, 1))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 35))
    h_lines = cv2.morphologyEx(edges, cv2.MORPH_OPEN, h_kernel)
    v_lines = cv2.morphologyEx(edges, cv2.MORPH_OPEN, v_kernel)

    structure = cv2.bitwise_or(h_lines, v_lines)
    structure = cv2.dilate(structure,
                           cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25)),
                           iterations=1)
    return structure


def _patch_overlap_ratio(mask: np.ndarray, x: int, y: int, w: int, h: int) -> float:
    """Fraction of the patch covered by the structure mask (0..1)."""
    H, W = mask.shape[:2]
    x2, y2 = min(W, x + w), min(H, y + h)
    x, y = max(0, x), max(0, y)
    if x2 <= x or y2 <= y:
        return 0.0
    region = mask[y:y2, x:x2]
    return float(np.count_nonzero(region)) / max(1, region.size)


# ---------------------------------------------------------------------------
# Dark-patch / oil-stain detector (precision-tightened).
# ---------------------------------------------------------------------------

def _detect_dark_patches(image_bgr: np.ndarray,
                          structure_mask: np.ndarray,
                          cloth_mask: Optional[np.ndarray] = None) -> List[List[int]]:
    """Locate localised dark blobs that genuinely look like oil stains / dirt.

    Real oil stains on a factory floor have:
      * low brightness AND low saturation (greyish, not coloured fabric)
      * a smooth, roughly round-or-blob shape (not a thin horizontal strip)
      * low internal texture (uniform, not full of edges)
      * are not located inside a rack or shelf (where shadow gaps live)
      * are not on top of fabric (fold shadows on a folded cloth are dark and
        smooth too, but they are not stains)
    Anything failing those tests is rejected to keep precision high.
    """
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]

    blurred = cv2.GaussianBlur(gray, (15, 15), 0)
    # Stricter threshold than the original 60, but loose enough to catch
    # genuine spills on a typical concrete / epoxy floor.
    _, dark = cv2.threshold(blurred, 50, 255, cv2.THRESH_BINARY_INV)
    # Saturation gate - oil/dirt is desaturated; coloured fabric or shadow on
    # blue cloth won't pass.
    desaturated = cv2.threshold(saturation, 70, 255, cv2.THRESH_BINARY_INV)[1]
    candidate = cv2.bitwise_and(dark, desaturated)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(candidate, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = gray.shape
    image_area = h * w

    boxes: List[List[int]] = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < image_area * 0.0015 or area > image_area * 0.05:
            continue

        x, y, bw, bh = cv2.boundingRect(c)

        # Reject thin strips (typical shelf-bottom shadows).
        aspect = max(bw, bh) / max(1, min(bw, bh))
        if aspect > 4.5:
            continue

        # Reject highly non-convex / irregular contours - real stains spread
        # smoothly so their solidity (area / convex_area) is high.
        hull = cv2.convexHull(c)
        hull_area = cv2.contourArea(hull) or 1
        solidity = area / hull_area
        if solidity < 0.65:
            continue

        # Internal texture check: real stains are smooth.
        patch = gray[y:y + bh, x:x + bw]
        if patch.size == 0:
            continue
        edge_patch = cv2.Canny(patch, 60, 180)
        internal_edge_density = float(np.count_nonzero(edge_patch)) / patch.size
        if internal_edge_density > 0.12:
            continue

        # Skip if patch is mostly inside a rack/shelf region.
        if _patch_overlap_ratio(structure_mask, x, y, bw, bh) > 0.45:
            continue

        # Skip if the surrounding area is dominated by cloth pixels (i.e.
        # this dark patch is a fold shadow nestled between fabric stacks,
        # not a stain on the floor). We check a generously-padded
        # neighbourhood (1x patch dimension on every side) and trigger the
        # veto if EITHER:
        #   - cloth covers >25% of the neighbourhood (clearly inside a
        #     fabric region), OR
        #   - cloth covers >10% AND the patch is in the upper 70% of the
        #     image (most floor stains are in the lower portion of the
        #     frame; high-up dark patches are almost always fabric shadows).
        if cloth_mask is not None:
            pad_x = max(20, bw)
            pad_y = max(20, bh)
            nx = max(0, x - pad_x)
            ny = max(0, y - pad_y)
            nw = bw + 2 * pad_x
            nh = bh + 2 * pad_y
            cloth_ratio = _patch_overlap_ratio(cloth_mask, nx, ny, nw, nh)
            patch_centre_y = y + bh / 2
            in_upper = patch_centre_y < 0.70 * h
            if cloth_ratio > 0.25 or (in_upper and cloth_ratio > 0.10):
                continue

        boxes.append([int(x), int(y), int(bw), int(bh)])
    return boxes


# ---------------------------------------------------------------------------
# Fabric-bundle / fabric-roll detector.
# ---------------------------------------------------------------------------

def _build_cloth_mask(image_bgr: np.ndarray) -> np.ndarray:
    """Binary mask of cloth-coloured pixels (white / cream / light grey).

    We deliberately constrain this to *bright* low-saturation tones (V >= 170)
    to avoid catching the typical concrete / epoxy factory floor, which is
    also low saturation but mid-brightness. Used both directly (to subdivide
    into shelf-level fabric stacks) and as a veto for the floor-scrap
    detector.
    """
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    cloth_mask = cv2.inRange(hsv, (0, 0, 170), (180, 75, 255))
    cloth_mask = cv2.morphologyEx(cloth_mask, cv2.MORPH_CLOSE,
                                  cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15)))
    cloth_mask = cv2.morphologyEx(cloth_mask, cv2.MORPH_OPEN,
                                  cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9)))
    return cloth_mask


def _detect_fabric_bundles(image_bgr: np.ndarray) -> List[List[int]]:
    """Find regions of folded / stacked fabric.

    Real folded-fabric stacks have a very distinctive signature:
      * mostly bright (white/cream/light cloth) or low-saturation mid-tone
      * many roughly horizontal short lines (the fold edges)
      * arranged in shelves/rows when on a rack
    Our strategy:
      1. Build the cloth-colour mask.
      2. If the mask covers a large fraction of the frame (>= 8%), subdivide
         it into horizontal shelf bands by projecting onto the y-axis and
         splitting at gaps.
      3. For each band (or, in the small-mask case, for each connected
         component), confirm the fold pattern via short horizontal Hough
         lines and emit a fabric_roll detection.
    """
    h, w = image_bgr.shape[:2]
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    cloth_mask = _build_cloth_mask(image_bgr)

    image_area = h * w
    cloth_pixels = int(np.count_nonzero(cloth_mask))
    cloth_ratio = cloth_pixels / max(1, image_area)

    candidate_boxes: List[List[int]] = []

    if cloth_ratio >= 0.08:
        # Dense fabric scene (e.g. a fabric store). Subdivide by rows of
        # cloth using a horizontal projection.
        row_density = (cloth_mask.sum(axis=1) // 255).astype(np.int32)
        threshold = max(40, int(0.25 * w))  # at least 25% of the row must be cloth
        in_band = False
        band_start = 0
        bands: List[Tuple[int, int]] = []
        for y in range(h):
            if row_density[y] >= threshold:
                if not in_band:
                    in_band = True
                    band_start = y
            else:
                if in_band:
                    if y - band_start >= 35:  # discard ultra-thin bands
                        bands.append((band_start, y))
                    in_band = False
        if in_band and h - band_start >= 35:
            bands.append((band_start, h))

        # For each band, find horizontal extents of the cloth mask.
        for y0, y1 in bands:
            row_slice = cloth_mask[y0:y1, :]
            col_density = (row_slice.sum(axis=0) // 255).astype(np.int32)
            col_thresh = max(20, int(0.10 * (y1 - y0)))
            in_seg = False
            seg_start = 0
            for x in range(w):
                if col_density[x] >= col_thresh:
                    if not in_seg:
                        in_seg = True
                        seg_start = x
                else:
                    if in_seg:
                        if x - seg_start >= 60:
                            candidate_boxes.append([seg_start, y0, x - seg_start, y1 - y0])
                        in_seg = False
            if in_seg and w - seg_start >= 60:
                candidate_boxes.append([seg_start, y0, w - seg_start, y1 - y0])
    else:
        # Sparse fabric scene - fall back to per-contour detection.
        contours, _ = cv2.findContours(cloth_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            area = cv2.contourArea(c)
            if area < image_area * 0.01 or area > image_area * 0.45:
                continue
            x, y, bw, bh = cv2.boundingRect(c)
            if bw < 60 or bh < 40:
                continue
            candidate_boxes.append([x, y, bw, bh])

    # Confirm each candidate has fold lines (rules out blank walls / sheets).
    accepted: List[List[int]] = []
    for x, y, bw, bh in candidate_boxes:
        # Skip almost-empty regions
        if bw * bh < image_area * 0.005:
            continue
        roi = gray[y:y + bh, x:x + bw]
        if roi.size == 0:
            continue
        edges = cv2.Canny(roi, 50, 150)
        lines = cv2.HoughLinesP(edges, 1, np.pi / 180,
                                threshold=20, minLineLength=15, maxLineGap=8)
        if lines is None:
            continue
        horizontal = 0
        for line in lines:
            x1, y1, x2, y2 = line[0]
            dx, dy = abs(x2 - x1), abs(y2 - y1)
            if dy <= 5 and dx >= 15:
                horizontal += 1
        if horizontal < 4:
            continue
        accepted.append([int(x), int(y), int(bw), int(bh)])
    return accepted


# ---------------------------------------------------------------------------
# Floor-scrap detector (precision-tightened).
# ---------------------------------------------------------------------------

def _detect_floor_scrap(image_bgr: np.ndarray,
                        structure_mask: np.ndarray,
                        bundle_boxes: List[List[int]],
                        cloth_mask: Optional[np.ndarray] = None) -> List[List[int]]:
    """Look for genuinely loose fabric scrap / threads on the floor.

    Real floor scrap is:
      * small (typically < 3% of floor area per piece)
      * irregular / wispy in shape
      * not inside a rack region
      * not inside an already-detected fabric bundle
      * not part of a large cloth-coloured region that overhangs the floor
        (such as the bottom of a fabric rack)
      * has high local edge density (frayed fibres) but low solidity
    """
    h, w = image_bgr.shape[:2]
    floor_y0 = int(h * 0.55)
    floor = image_bgr[floor_y0:, :]
    fh, fw = floor.shape[:2]
    if fh < 30 or fw < 30:
        return []

    gray = cv2.cvtColor(floor, cv2.COLOR_BGR2GRAY)

    if cloth_mask is None:
        cloth_mask = _build_cloth_mask(image_bgr)
    cloth_floor_ratio = float(np.count_nonzero(cloth_mask[floor_y0:, :])) / max(1, fh * fw)

    # Find the floor's dominant tone so we can measure colour deviation per patch.
    floor_mean = float(np.mean(gray))
    floor_std = float(np.std(gray)) or 1.0

    edges = cv2.Canny(gray, 80, 200)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes: List[List[int]] = []
    floor_area = fh * fw

    for c in contours:
        area = cv2.contourArea(c)
        # Only TRULY small loose objects qualify as scrap. A whole-rack-sized
        # blob is not scrap.
        if area < floor_area * 0.003 or area > floor_area * 0.025:
            continue

        x, y, bw, bh = cv2.boundingRect(c)
        global_x = x
        global_y = y + floor_y0

        # Wispy shapes have low solidity (lots of concavities). We allow
        # slightly compact pieces too because cv2.contourArea on a
        # closed contour from Canny+morph_close can be quite high.
        hull = cv2.convexHull(c)
        hull_area = cv2.contourArea(hull) or 1
        solidity = area / hull_area
        if solidity > 0.92:
            # Almost perfectly compact (e.g. a smooth ellipse) - probably an
            # equipment foot or a label, not scrap.
            continue

        # Patch should differ noticeably in tone from the floor mean (a piece
        # of fabric on the floor is either lighter or darker than the floor).
        patch = gray[y:y + bh, x:x + bw]
        if patch.size == 0:
            continue
        deviation = abs(float(np.mean(patch)) - floor_mean) / floor_std
        if deviation < 0.5:
            continue

        # Reject if the patch sits inside a rack/shelf region (shadow inside a
        # rack is not floor scrap).
        if _patch_overlap_ratio(structure_mask, global_x, global_y, bw, bh) > 0.35:
            continue

        # Reject if the patch sits inside a recognised fabric bundle.
        inside_bundle = False
        for bx, by, bw2, bh2 in bundle_boxes:
            if (global_x >= bx and global_y >= by
                    and global_x + bw <= bx + bw2 and global_y + bh <= by + bh2):
                inside_bundle = True
                break
        if inside_bundle:
            continue

        # Reject if the patch is mostly cloth-coloured AND a lot of cloth
        # already lives on the floor row (= rack-of-fabric scenario).
        if cloth_floor_ratio > 0.10:
            cloth_overlap = _patch_overlap_ratio(cloth_mask,
                                                  global_x, global_y, bw, bh)
            if cloth_overlap > 0.30:
                continue

        boxes.append([int(global_x), int(global_y), int(bw), int(bh)])
    return boxes


# ---------------------------------------------------------------------------
# Generic image-level metrics
# ---------------------------------------------------------------------------

def _measure_clutter(image_bgr: np.ndarray) -> Dict[str, float]:
    """Compute edge density and a coarse object count for clutter scoring."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 60, 160)
    edge_density = float(np.sum(edges > 0) / edges.size)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    blob_count = sum(1 for c in contours if cv2.contourArea(c) > 200)

    return {"edge_density": edge_density, "blob_count": blob_count}


def _measure_alignment(image_bgr: np.ndarray) -> Dict[str, float]:
    """
    Score arrangement quality by looking for strong horizontal / vertical
    lines (well-aligned racks, machines, tables produce many parallel lines).
    Lower values mean less structured, more random arrangement.
    """
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 80, 180)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80,
                            minLineLength=60, maxLineGap=12)
    if lines is None:
        return {"alignment_score": 0.0, "line_count": 0}

    horizontal = 0
    vertical = 0
    diagonal = 0
    for line in lines:
        x1, y1, x2, y2 = line[0]
        dx, dy = abs(x2 - x1), abs(y2 - y1)
        if dx == 0 and dy == 0:
            continue
        if dy < 5 and dx > 20:
            horizontal += 1
        elif dx < 5 and dy > 20:
            vertical += 1
        else:
            diagonal += 1
    total = horizontal + vertical + diagonal
    if total == 0:
        return {"alignment_score": 0.0, "line_count": 0}
    aligned_ratio = (horizontal + vertical) / total
    return {"alignment_score": float(aligned_ratio), "line_count": int(total)}


def _measure_brightness(image_bgr: np.ndarray) -> Dict[str, float]:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    return {
        "brightness": float(np.mean(gray)),
        "variance": float(np.var(gray)),
    }


def _measure_color_codes(image_bgr: np.ndarray) -> Dict[str, bool]:
    """
    Heuristically check whether obvious safety / 5S colour patches are visible
    (yellow floor tape, red bins, green safety markers). Used by the
    Standardize check.
    """
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    masks = {
        "yellow": cv2.inRange(hsv, (20, 100, 100), (35, 255, 255)),
        "red":    cv2.inRange(hsv, (0, 130, 100),  (10, 255, 255)) +
                  cv2.inRange(hsv, (170, 130, 100), (179, 255, 255)),
        "green":  cv2.inRange(hsv, (40, 100, 100), (80, 255, 255)),
    }
    pixel_total = image_bgr.shape[0] * image_bgr.shape[1]
    threshold = 0.005  # 0.5% of pixels of a given colour counts as "present"
    return {color: bool(np.sum(mask > 0) / pixel_total > threshold)
            for color, mask in masks.items()}


# ---------------------------------------------------------------------------
# Top-level heuristic pipeline
# ---------------------------------------------------------------------------

def detect_heuristics(image_bgr: np.ndarray, image_index: int) -> Dict[str, Any]:
    """Compute all OpenCV-driven signals for a single image."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    structure_mask = _build_structure_mask(gray)
    cloth_mask = _build_cloth_mask(image_bgr)

    detections: List[Dict[str, Any]] = []

    # Step 1: positive detections (fabric stacks). These both seed the
    # zone-aware allowed-item count AND act as a veto for scrap detection.
    bundle_boxes = _detect_fabric_bundles(image_bgr)
    for box in bundle_boxes:
        detections.append({
            "label": "fabric_roll",
            "category": "object",
            "confidence": 0.65,
            "box": box,
            "image_index": image_index,
            "source": "heuristic_fabric_bundle",
        })

    # Step 2: negative detections (stains, scrap) - now run with structure
    # and bundle awareness so they don't fire on shadows or stacks.
    for box in _detect_dark_patches(image_bgr, structure_mask, cloth_mask=cloth_mask):
        detections.append({
            "label": "oil_stain",
            "category": "stain",
            "confidence": 0.55,
            "box": box,
            "image_index": image_index,
        })

    for box in _detect_floor_scrap(image_bgr, structure_mask, bundle_boxes,
                                    cloth_mask=cloth_mask):
        detections.append({
            "label": "fabric_scrap_floor",
            "category": "waste",
            "confidence": 0.50,
            "box": box,
            "image_index": image_index,
        })

    return {
        "detections": detections,
        "clutter":    _measure_clutter(image_bgr),
        "alignment":  _measure_alignment(image_bgr),
        "brightness": _measure_brightness(image_bgr),
        "colors":     _measure_color_codes(image_bgr),
    }


def detect_all(image_bgr: np.ndarray, image_index: int) -> Dict[str, Any]:
    """Combine YOLO + OpenCV signals for one image. Pure, side-effect free."""
    heuristic = detect_heuristics(image_bgr, image_index)
    yolo_dets = detect_yolo(image_bgr, image_index)

    return {
        "detections": heuristic["detections"] + yolo_dets,
        "metrics": {
            "clutter":    heuristic["clutter"],
            "alignment":  heuristic["alignment"],
            "brightness": heuristic["brightness"],
            "colors":     heuristic["colors"],
        },
    }


def annotate(image_bgr: np.ndarray, issues: List[Dict[str, Any]]) -> np.ndarray:
    """
    Draw bounding boxes + severity-coloured labels on a copy of the image.
    Severity colours follow the spec:
        critical -> red
        moderate -> yellow
        minor    -> green
    """
    out = image_bgr.copy()
    severity_color = {
        "critical": (0, 0, 220),
        "moderate": (0, 200, 220),
        "minor":    (60, 200, 60),
    }
    for issue in issues:
        box = issue.get("box")
        if not box:
            continue
        x, y, w, h = [int(v) for v in box]
        color = severity_color.get(issue.get("severity", "moderate"), (0, 200, 220))
        cv2.rectangle(out, (x, y), (x + w, y + h), color, 2)

        label = issue.get("label", "")
        if label:
            (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            ty = max(0, y - 6)
            cv2.rectangle(out, (x, ty - th - 4), (x + tw + 6, ty), color, -1)
            cv2.putText(out, label, (x + 3, ty - 3),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return out
