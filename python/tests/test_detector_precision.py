"""Precision tests for the v2 detector.

These tests ensure the heuristic detector does not produce false-positive
"fabric waste" or "oil stain" findings on real factory photos that contain
neat fabric stacks on racks. The reference image is a real photo from a
trim store / fabric staging area.

Run with:
    python python/tests/test_detector_precision.py

Returns exit 0 on PASS, 1 on FAIL.
"""
from __future__ import annotations

import io
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from detector import (  # noqa: E402  (path setup must happen first)
    annotate,
    detect_heuristics,
    _detect_fabric_bundles,
    _detect_floor_scrap,
    _detect_dark_patches,
    _build_structure_mask,
    _build_cloth_mask,
)
from rules import evaluate  # noqa: E402

FIXTURES = os.path.join(ROOT, "fixtures")
REAL_RACK = os.path.join(FIXTURES, "fabric_bundles_on_rack.jpg")


def _load(path: str) -> np.ndarray:
    img = cv2.imread(path)
    if img is None:
        raise SystemExit(f"Cannot read fixture: {path}")
    return img


def _make_real_scrap_scene() -> np.ndarray:
    """Synthesize a factory floor with genuine cloth scraps + oil spills so
    the detector is sanity-checked on positive cases. The floor is a dark
    epoxy/concrete tone so cloth scraps stand out clearly. Scraps are drawn
    with frayed/jagged outlines to mimic real torn fabric."""
    h, w = 720, 1280
    img = Image.new("RGB", (w, h), (95, 90, 85))
    draw = ImageDraw.Draw(img)

    rng = np.random.default_rng(0)
    # Frayed irregular cloth-scrap pieces - many points with high radial noise.
    for cx, cy in [(180, 560), (480, 590), (820, 610), (1100, 570), (340, 670)]:
        n = 24
        pts = []
        base_r = float(rng.integers(28, 45))
        for k in range(n):
            ang = 2 * np.pi * k / n + float(rng.uniform(-0.15, 0.15))
            # Big radial variation to give each piece a frayed silhouette.
            r = base_r * float(rng.uniform(0.45, 1.2))
            pts.append((cx + int(r * np.cos(ang)),
                        cy + int(r * 0.65 * np.sin(ang))))
        draw.polygon(pts, fill=(235, 230, 220), outline=(130, 125, 115))
        # add a few stray threads radiating outward (real fraying)
        for _ in range(5):
            ang = float(rng.uniform(0, 2 * np.pi))
            l = float(rng.uniform(15, 30))
            x2 = cx + int((base_r + l) * np.cos(ang))
            y2 = cy + int((base_r * 0.65 + l) * np.sin(ang))
            draw.line([cx + int(base_r * np.cos(ang)),
                       cy + int(base_r * 0.65 * np.sin(ang)),
                       x2, y2], fill=(220, 215, 205), width=2)

    # A couple of clearly dark oil-like spills with smooth boundaries.
    for cx, cy in [(620, 680), (970, 695)]:
        draw.ellipse([cx - 50, cy - 24, cx + 50, cy + 24], fill=(20, 18, 15))
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def _make_clean_floor_scene() -> np.ndarray:
    """An empty, clean factory floor - should produce no negative findings."""
    h, w = 720, 1280
    img = np.full((h, w, 3), (200, 188, 168), dtype=np.uint8)
    img += (np.random.default_rng(7).integers(-6, 6, img.shape, dtype=np.int16)
            .clip(-128, 127).astype(np.int8)).astype(np.uint8)
    return img


def _check(label: str, condition: bool, detail: str = "") -> bool:
    icon = "PASS" if condition else "FAIL"
    print(f"  [{icon}] {label}{(' - ' + detail) if detail else ''}")
    return condition


def main() -> int:
    failed = 0

    # -----------------------------------------------------------------------
    print("=" * 72)
    print("Test 1: real photo of folded fabric stacks on a rack")
    print("=" * 72)
    if not os.path.exists(REAL_RACK):
        print(f"  SKIP - fixture missing: {REAL_RACK}")
    else:
        img = _load(REAL_RACK)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        struct = _build_structure_mask(gray)
        cloth = _build_cloth_mask(img)
        bundles = _detect_fabric_bundles(img)
        scraps = _detect_floor_scrap(img, struct, bundles, cloth_mask=cloth)
        stains = _detect_dark_patches(img, struct, cloth_mask=cloth)

        h, w = img.shape[:2]
        print(f"  image     : {w}x{h}")
        print(f"  bundles   : {len(bundles)} fabric stack(s) detected")
        print(f"  scrap     : {len(scraps)} floor-scrap blob(s)")
        print(f"  stains    : {len(stains)} oil-stain blob(s)")

        if not _check("fabric_bundle detector finds at least 1 stack",
                      len(bundles) >= 1):
            failed += 1
        if not _check("no spurious 'fabric_scrap_floor' findings",
                      len(scraps) == 0,
                      f"got {len(scraps)} false positives"):
            failed += 1
        if not _check("no spurious 'oil_stain' findings",
                      len(stains) == 0,
                      f"got {len(stains)} false positives"):
            failed += 1

        # End-to-end check: this is clearly a fabric store, so run rule
        # engine for Zone-9 FABRIC STORE where fabric_roll is allowed
        # inventory. Confirm no spurious Shine or Sort issues for the fabric.
        result = detect_heuristics(img, image_index=0)
        ev = evaluate(
            zone_id="zone-9",
            detections=result["detections"],
            per_image_metrics=[{
                "clutter": result["clutter"],
                "alignment": result["alignment"],
                "brightness": result["brightness"],
                "colors": result["colors"],
            }],
            history=[],
        )
        shine_issues = [i for i in ev["issues"] if i["s"] == "shine"]
        sort_issues = [i for i in ev["issues"] if i["s"] == "sort"]

        if not _check("Zone-9 FABRIC STORE: no fabric-waste Shine issues",
                      not any("fabric" in i["label"].lower() or "waste" in i["label"].lower()
                              for i in shine_issues),
                      f"got: {[i['label'] for i in shine_issues]}"):
            failed += 1
        if not _check(
            "Zone-9 FABRIC STORE: no 'Forbidden item' or 'Unrelated item' for fabric",
            not any("fabric" in i["label"].lower() for i in sort_issues),
            f"got: {[i['label'] for i in sort_issues]}",
        ):
            failed += 1
        print(f"  end-to-end scores: total {ev['scores']['total']}/20  status={ev['status']}")

        # save annotated output for visual inspection
        out_path = os.path.join(FIXTURES, "fabric_bundles_on_rack_annotated_v2.jpg")
        annotated = annotate(img, ev["issues"])
        cv2.imwrite(out_path, annotated)
        print(f"  wrote annotated preview -> {out_path}")

    # -----------------------------------------------------------------------
    print()
    print("=" * 72)
    print("Test 2: synthetic scene with REAL scrap + REAL stains (sanity)")
    print("=" * 72)
    img = _make_real_scrap_scene()
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    struct = _build_structure_mask(gray)
    cloth = _build_cloth_mask(img)
    bundles = _detect_fabric_bundles(img)
    scraps = _detect_floor_scrap(img, struct, bundles, cloth_mask=cloth)
    stains = _detect_dark_patches(img, struct, cloth_mask=cloth)
    print(f"  bundles : {len(bundles)}  scrap : {len(scraps)}  stains : {len(stains)}")
    if not _check("scrap detector still fires on real wispy debris",
                  len(scraps) >= 2,
                  f"only got {len(scraps)} - detector may be too strict"):
        failed += 1
    if not _check("stain detector still fires on real dark spills",
                  len(stains) >= 1,
                  f"only got {len(stains)} - detector may be too strict"):
        failed += 1

    # -----------------------------------------------------------------------
    print()
    print("=" * 72)
    print("Test 3: clean factory floor (no findings expected)")
    print("=" * 72)
    img = _make_clean_floor_scene()
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    struct = _build_structure_mask(gray)
    cloth = _build_cloth_mask(img)
    bundles = _detect_fabric_bundles(img)
    scraps = _detect_floor_scrap(img, struct, bundles, cloth_mask=cloth)
    stains = _detect_dark_patches(img, struct, cloth_mask=cloth)
    print(f"  bundles : {len(bundles)}  scrap : {len(scraps)}  stains : {len(stains)}")
    if not _check("no fabric-bundle false positives on clean floor",
                  len(bundles) == 0,
                  f"got {len(bundles)} false positives"):
        failed += 1
    if not _check("no scrap false positives on clean floor",
                  len(scraps) == 0,
                  f"got {len(scraps)} false positives"):
        failed += 1
    if not _check("no stain false positives on clean floor",
                  len(stains) == 0,
                  f"got {len(stains)} false positives"):
        failed += 1

    # -----------------------------------------------------------------------
    print()
    if failed == 0:
        print(f"All precision tests PASSED.")
        return 0
    print(f"{failed} precision test(s) FAILED.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
