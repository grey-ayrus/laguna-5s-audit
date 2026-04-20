"""Quick API smoke test for the v2 5S audit system.

Generates synthetic test images that exercise the OpenCV detection
pipeline (clutter, dirt, fabric scrap, dark patches), then posts them
to /api/audits and prints the parsed response. Also exercises:
  * GET /api/audits/zones
  * GET /api/audits/stats
  * GET /api/audits/:id
  * GET /api/audits/:id/pdf

Usage: python scripts/smoke_test.py
"""

from __future__ import annotations

import base64
import io
import json
import os
import random
import sys
from typing import Any
from urllib import error, request

import numpy as np
from PIL import Image, ImageDraw

API = os.environ.get("API_BASE", "http://localhost:5000/api/audits")


def encode_image(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def make_messy_factory_image(seed: int = 0) -> Image.Image:
    """Create a deterministic synthetic factory-floor scene that should
    trigger several heuristic detections."""

    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)

    h, w = 720, 1280
    floor_color = (190, 175, 155)
    canvas = np.full((h, w, 3), floor_color, dtype=np.uint8)

    canvas += (np_rng.integers(-12, 12, canvas.shape, dtype=np.int16)
               .clip(-128, 127).astype(np.int8)).astype(np.uint8)

    img = Image.fromarray(canvas)
    draw = ImageDraw.Draw(img)

    for _ in range(rng.randint(8, 14)):
        x = rng.randint(0, w - 80)
        y = rng.randint(0, h - 60)
        bw = rng.randint(40, 160)
        bh = rng.randint(20, 80)
        color = (rng.randint(40, 220), rng.randint(40, 220), rng.randint(40, 220))
        draw.rectangle([x, y, x + bw, y + bh], fill=color, outline=(0, 0, 0))

    for _ in range(rng.randint(3, 6)):
        x = rng.randint(0, w - 1)
        y = rng.randint(int(h * 0.6), h - 1)
        rad = rng.randint(20, 60)
        draw.ellipse([x - rad, y - rad // 2, x + rad, y + rad // 2], fill=(35, 30, 25))

    for _ in range(rng.randint(40, 80)):
        x = rng.randint(0, w - 1)
        y = rng.randint(int(h * 0.55), h - 1)
        l = rng.randint(15, 60)
        draw.line([x, y, x + l, y + rng.randint(-4, 4)], fill=(245, 245, 240), width=2)

    return img


def make_clean_factory_image(seed: int = 100) -> Image.Image:
    """A neat scene with aligned shapes and no dirt."""

    rng = random.Random(seed)
    h, w = 720, 1280
    img = Image.new("RGB", (w, h), (215, 210, 200))
    draw = ImageDraw.Draw(img)

    for col in range(4):
        for row in range(3):
            x = 120 + col * 260
            y = 120 + row * 180
            draw.rectangle([x, y, x + 200, y + 130], fill=(110, 140, 200), outline=(0, 0, 0), width=3)

    draw.rectangle([60, 600, w - 60, 690], outline=(220, 30, 30), width=6)
    draw.text((90, 625), "SOP CHART - 5S DAILY CHECK", fill=(20, 20, 20))

    return img


def post_json(path: str, body: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(body).encode()
    req = request.Request(f"{API}{path}", data=data,
                          headers={"Content-Type": "application/json"},
                          method="POST")
    try:
        with request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except error.HTTPError as e:
        body = e.read().decode()
        raise SystemExit(f"POST {path} -> HTTP {e.code}: {body}")


def get_json(path: str) -> dict[str, Any]:
    try:
        with request.urlopen(f"{API}{path}", timeout=30) as resp:
            return json.loads(resp.read().decode())
    except error.HTTPError as e:
        body = e.read().decode()
        raise SystemExit(f"GET {path} -> HTTP {e.code}: {body}")


def get_bytes(path: str) -> tuple[int, bytes, str]:
    with request.urlopen(f"{API}{path}", timeout=60) as resp:
        return resp.status, resp.read(), resp.headers.get("Content-Type", "")


def heading(label: str) -> None:
    print()
    print("=" * 70)
    print(f"  {label}")
    print("=" * 70)


def summarise_audit(payload: dict[str, Any]) -> None:
    a = payload.get("audit", payload)
    print(f"  id          : {a.get('_id') or a.get('id')}")
    print(f"  zone        : {a.get('zoneCode')} {a.get('zoneName')} ({a.get('zoneCategory')})")
    s = a.get("scores", {})
    print(f"  scores      : sort={s.get('sort')} setInOrder={s.get('setInOrder')} "
          f"shine={s.get('shine')} standardize={s.get('standardize')} sustain={s.get('sustain')} "
          f"-> total={s.get('total')}/20  status={a.get('status')}")
    issues = a.get("issues", [])
    print(f"  issues      : {len(issues)} total")
    for i in issues[:6]:
        print(f"     - [{i.get('s')}/{i.get('severity')}] {i.get('label')}  ({i.get('tag')})")
    if len(issues) > 6:
        print(f"     ...and {len(issues) - 6} more")
    aps = a.get("actionPoints", [])
    print(f"  actions     : {len(aps)} items")
    for ap in aps[:5]:
        print(f"     * {ap}")
    imgs = a.get("images", [])
    print(f"  images      : {len(imgs)} (annotated: "
          f"{sum(1 for x in imgs if x.get('annotated'))})")


def main() -> int:
    heading("GET /zones")
    zones = get_json("/zones")
    print(f"  zones returned: {len(zones.get('zones', []))}")
    sample = zones["zones"][13]
    print(f"  e.g. {sample['code']} {sample['name']} ({sample['category']}) "
          f"forbidden={sample.get('forbidden', [])[:3]}")

    heading("Audit #1: Zone-14 CUTTING - 3 messy images")
    cutting_images = [encode_image(make_messy_factory_image(s)) for s in (1, 2, 3)]
    res1 = post_json("", {"zoneId": "zone-14", "images": cutting_images})
    summarise_audit(res1)
    audit1_id = res1["audit"]["_id"]

    heading("Audit #2: Zone-25 CANTEEN - 1 clean image")
    clean_img = encode_image(make_clean_factory_image(seed=42))
    res2 = post_json("", {"zoneId": "zone-25", "images": [clean_img]})
    summarise_audit(res2)

    heading("Audit #3: Zone-9 FABRIC STORE - 4 mixed images")
    mixed = ([encode_image(make_messy_factory_image(s)) for s in (5, 6)]
             + [encode_image(make_clean_factory_image(s)) for s in (200, 201)])
    res3 = post_json("", {"zoneId": "zone-9", "images": mixed})
    summarise_audit(res3)

    heading("Audit #4: REPEAT Zone-14 (Sustain trigger expected)")
    res4 = post_json("", {"zoneId": "zone-14",
                          "images": [encode_image(make_messy_factory_image(99))]})
    summarise_audit(res4)
    sustain_issues = [i for i in res4["audit"]["issues"] if i.get("s") == "sustain"]
    print(f"  >> sustain issues raised on repeat: {len(sustain_issues)}")
    for i in sustain_issues[:5]:
        print(f"     ~ {i['label']} ({i['tag']})")

    heading("Audit #5: Validation - missing zoneId should 400")
    try:
        post_json("", {"images": [clean_img]})
        print("  FAIL: expected error but got success")
    except SystemExit as e:
        print(f"  OK -> {e}")

    heading("Audit #6: Validation - 5 images should 400")
    try:
        post_json("", {"zoneId": "zone-14", "images": [clean_img] * 5})
        print("  FAIL: expected error but got success")
    except SystemExit as e:
        print(f"  OK -> {e}")

    heading("Audit #7: Validation - bogus zone should 400")
    try:
        post_json("", {"zoneId": "zone-9999", "images": [clean_img]})
        print("  FAIL: expected error but got success")
    except SystemExit as e:
        print(f"  OK -> {e}")

    heading(f"GET /{audit1_id} (round-trip)")
    fetched = get_json(f"/{audit1_id}")
    summarise_audit(fetched)

    heading("GET /stats")
    stats = get_json("/stats")["stats"]
    print(f"  totalAudits  : {stats['totalAudits']}")
    print(f"  zonesAudited : {stats['zonesAudited']}/{stats['zonesTotal']}")
    print(f"  status counts: {stats['statusDistribution']}")
    if stats.get("bestZone"):
        b = stats["bestZone"]
        print(f"  best zone    : {b['zoneCode']} {b['zoneName']} -> avg "
              f"{b['averageScore']}/20 (latest {b['latestScore']}/20, n={b['count']})")
    if stats.get("worstZone"):
        w = stats["worstZone"]
        print(f"  worst zone   : {w['zoneCode']} {w['zoneName']} -> avg "
              f"{w['averageScore']}/20 (latest {w['latestScore']}/20, n={w['count']})")

    heading("GET / (list audits)")
    listing = get_json("")
    audits = listing.get("audits", [])
    print(f"  audits listed: {len(audits)}")
    for a in audits[:6]:
        print(f"   - {a.get('zoneCode')} {a.get('zoneName')} -> {a['scores']['total']}/20 "
              f"({a['status']}) at {a.get('createdAt')}")

    heading(f"GET /{audit1_id}/pdf")
    status, body, ctype = get_bytes(f"/{audit1_id}/pdf")
    out_path = os.path.join("uploads", f"smoke_{audit1_id}.pdf")
    os.makedirs("uploads", exist_ok=True)
    with open(out_path, "wb") as fh:
        fh.write(body)
    print(f"  status={status} content-type={ctype} bytes={len(body)} -> {out_path}")
    if not body.startswith(b"%PDF"):
        print("  FAIL: response is not a valid PDF (missing %PDF header)")
        return 1
    print("  OK -> begins with %PDF magic header")

    print("\nAll smoke checks completed successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
