"""End-to-end test: post the real fabric-rack photo through the full API stack
and verify there are no spurious 'Fabric waste' or 'Oil stain' findings."""
from __future__ import annotations

import base64
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(ROOT, "python", "fixtures", "fabric_bundles_on_rack.jpg")
NODE_API = "http://127.0.0.1:5000/api/audits"


def main() -> int:
    if not os.path.exists(FIXTURE):
        print(f"ERROR: fixture missing: {FIXTURE}")
        return 1

    with open(FIXTURE, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode("ascii")
    data_url = f"data:image/jpeg;base64,{b64}"

    body = {
        "zoneId": "zone-9",  # FABRIC STORE
        "images": [data_url],
    }
    req = urllib.request.Request(
        NODE_API,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    audit = payload["audit"]
    scores = audit["scores"]
    issues = audit["issues"]

    print("=" * 70)
    print("Real fabric-rack photo posted to Zone-9 FABRIC STORE")
    print("=" * 70)
    print(f"  total score : {scores['total']}/20  ({audit['status']})")
    print(f"  scores      : sort={scores['sort']} setInOrder={scores['setInOrder']} "
          f"shine={scores['shine']} standardize={scores['standardize']} sustain={scores['sustain']}")
    print(f"  issues      : {len(issues)}")
    for i in issues:
        print(f"   - [{i['s']}/{i['severity']}] {i['label']}  ({i.get('tag', '')})")

    spurious_waste = [i for i in issues if "fabric waste" in i["label"].lower()]
    spurious_stain = [i for i in issues if "oil" in i["label"].lower() or "stain" in i["label"].lower()]
    forbidden_fabric = [i for i in issues
                         if "forbidden" in i["label"].lower() and "fabric" in i["label"].lower()]
    unrelated_fabric = [i for i in issues
                         if "unrelated" in i["label"].lower() and "fabric" in i["label"].lower()]

    print()
    failed = 0
    if spurious_waste:
        print(f"FAIL: {len(spurious_waste)} fabric-waste finding(s) on a clean fabric rack")
        failed += 1
    else:
        print("PASS: no fabric-waste findings")
    if spurious_stain:
        print(f"FAIL: {len(spurious_stain)} oil-stain finding(s) on a clean rack")
        failed += 1
    else:
        print("PASS: no oil-stain findings")
    if forbidden_fabric or unrelated_fabric:
        print(f"FAIL: fabric mistakenly flagged as forbidden/unrelated in a fabric store")
        failed += 1
    else:
        print("PASS: fabric correctly recognised as allowed inventory")

    if scores["total"] < 16:
        print(f"FAIL: total score {scores['total']}/20 is too low for a clean rack")
        failed += 1
    else:
        print(f"PASS: total score {scores['total']}/20 is in the Green band")

    if failed == 0:
        print()
        print("All end-to-end checks passed.")
        return 0
    print()
    print(f"{failed} end-to-end check(s) failed.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
