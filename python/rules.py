"""
Zone-aware 5S rule engine for the Laguna India audit system.

Given the neutral detections + heuristics produced by `detector.py`, this
module does the *factory-specific* reasoning: it cross-references everything
against the zone configuration in `zones.json` and emits the canonical
5S audit output:

    {
      "scores":         {sort, setInOrder, shine, standardize, sustain, total},
      "issues":         [{s, label, severity, image_index, box?}, ...],
      "remarks":        "...",
      "actionPoints":   [...],
      "summary":        "short factory-friendly summary",
      "annotations":    [{image_index, issues}, ...],
    }
"""
from __future__ import annotations

import json
import os
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional

ZONES_PATH = os.path.join(os.path.dirname(__file__), "zones.json")
with open(ZONES_PATH, "r", encoding="utf-8") as fh:
    _ZONES = {z["id"]: z for z in json.load(fh)["zones"]}


def get_zone(zone_id: str) -> Dict[str, Any]:
    return _ZONES.get(zone_id) or {
        "id": zone_id,
        "code": "Zone-?",
        "name": "Unknown Zone",
        "category": "Unknown",
        "allowedItems": [],
        "mustHave": [],
        "forbidden": [],
        "clutterLimit": 0.20,
    }


# ---------------------------------------------------------------------------
# Severity helpers
# ---------------------------------------------------------------------------

# Items that, if present in a forbidden context, are always flagged critical.
_CRITICAL_FORBIDDEN = {"food", "food_waste", "cigarette", "oil_stain"}


def _severity_for(label: str, count: int = 1) -> str:
    if label in _CRITICAL_FORBIDDEN:
        return "critical"
    if count >= 4:
        return "critical"
    if count >= 2:
        return "moderate"
    return "minor"


# ---------------------------------------------------------------------------
# Score conversion - rebalanced rule chosen by the user.
#   0 issues       -> 4
#   1-2 issues     -> 3
#   3-4 issues     -> 2
#   5+ issues      -> 1
# Critical issues are weighted: each critical counts as 2 issues for scoring.
# ---------------------------------------------------------------------------

def _weighted_count(issues: List[Dict[str, Any]]) -> int:
    weight = 0
    for issue in issues:
        weight += 2 if issue.get("severity") == "critical" else 1
    return weight


def _bucket_score(weighted: int) -> int:
    if weighted == 0:
        return 4
    if weighted <= 2:
        return 3
    if weighted <= 4:
        return 2
    return 1


# ---------------------------------------------------------------------------
# 1S - SORT
# ---------------------------------------------------------------------------

def _check_sort(detections, metrics, zone) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    allowed = set(zone["allowedItems"])
    forbidden = set(zone["forbidden"])

    # Group detections by label to count "excess" of allowed items.
    by_label: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for det in detections:
        if det["category"] != "object":
            continue
        by_label[det["label"]].append(det)

    for label, dets in by_label.items():
        first = dets[0]
        if label in forbidden:
            issues.append({
                "s": "sort",
                "label": f"Forbidden item: {label.replace('_', ' ')}",
                "severity": _severity_for(label, len(dets)),
                "image_index": first["image_index"],
                "box": first["box"],
                "tag": "Unnecessary item",
            })
        elif label not in allowed and label not in {"person", "sign"}:
            issues.append({
                "s": "sort",
                "label": f"Unrelated item: {label.replace('_', ' ')}",
                "severity": "moderate",
                "image_index": first["image_index"],
                "box": first["box"],
                "tag": "Idle object",
            })
        elif label in allowed and len(dets) > 6:
            # "Excess inventory" should only fire when we have *individual*
            # object detections (i.e. YOLO-class hits with discrete bounding
            # boxes per item). Skip it for heuristic detections like our
            # fabric-bundle blob estimator, which can group many rolls into one
            # bounding box and would otherwise mislead the count.
            if any(d.get("source", "").startswith("heuristic") for d in dets):
                continue
            issues.append({
                "s": "sort",
                "label": f"Excess inventory: {len(dets)} {label.replace('_', ' ')}s",
                "severity": "moderate",
                "image_index": first["image_index"],
                "box": first["box"],
                "tag": "Excess inventory",
            })

    # Clutter / density check (averaged across uploaded images).
    avg_density = sum(m["clutter"]["edge_density"] for m in metrics) / max(1, len(metrics))
    if avg_density > zone["clutterLimit"]:
        worst = max(range(len(metrics)),
                    key=lambda i: metrics[i]["clutter"]["edge_density"])
        issues.append({
            "s": "sort",
            "label": f"Clutter detected (density {avg_density:.0%})",
            "severity": "moderate" if avg_density < zone["clutterLimit"] + 0.05 else "critical",
            "image_index": worst,
            "box": None,
            "tag": "Clutter detected",
        })
    return issues


# ---------------------------------------------------------------------------
# 2S - SET IN ORDER
# ---------------------------------------------------------------------------

def _check_set_in_order(detections, metrics, zone) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []

    # Alignment - compute average aligned-line ratio across images.
    alignments = [m["alignment"]["alignment_score"] for m in metrics]
    avg_align = sum(alignments) / max(1, len(alignments))

    # Production / store zones should look highly orthogonal (machines, racks);
    # office / welfare zones get a more lenient threshold.
    structural_zones = {"Production", "Stores", "Operations", "Quality"}
    threshold = 0.55 if zone["category"] in structural_zones else 0.40
    if avg_align < threshold:
        worst = min(range(len(metrics)),
                    key=lambda i: metrics[i]["alignment"]["alignment_score"])
        issues.append({
            "s": "setInOrder",
            "label": f"Improper arrangement (alignment {avg_align:.0%})",
            "severity": "moderate" if avg_align > threshold - 0.15 else "critical",
            "image_index": worst,
            "box": None,
            "tag": "Improper arrangement",
        })

    # Missing labels - we use the presence of "label" in zone.mustHave as a
    # proxy. If the zone needs labels but YOLO didn't detect any signage and
    # no detections in the image carry a "sign" / "label" tag, flag it.
    if "label" in zone["mustHave"]:
        has_label_signal = any(d["label"] in {"sign", "label"} for d in detections)
        if not has_label_signal:
            issues.append({
                "s": "setInOrder",
                "label": "No labels visible on racks / bins",
                "severity": "moderate",
                "image_index": 0,
                "box": None,
                "tag": "No label",
            })

    # Blocked pathway - if too many discrete *YOLO* objects sit low in the
    # frame, treat it as a possible blocked walkway. We deliberately exclude
    # heuristic detections (e.g. fabric bundles on a rack) because those
    # produce one big box per stack and would over-trigger this check.
    floor_blockers = 0
    for det in detections:
        if det["category"] != "object" or not det.get("box"):
            continue
        if det.get("source", "").startswith("heuristic"):
            continue
        x, y, w, h = det["box"]
        if y > 240:
            floor_blockers += 1
    if floor_blockers >= 4:
        issues.append({
            "s": "setInOrder",
            "label": f"Blocked walkway ({floor_blockers} objects on/near floor)",
            "severity": "moderate",
            "image_index": 0,
            "box": None,
            "tag": "Blocked pathway",
        })

    return issues


# ---------------------------------------------------------------------------
# 3S - SHINE
# ---------------------------------------------------------------------------

def _check_shine(detections, metrics, zone) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []

    for det in detections:
        if det["category"] == "stain":
            issues.append({
                "s": "shine",
                "label": "Possible oil / dirt stain",
                "severity": "moderate",
                "image_index": det["image_index"],
                "box": det["box"],
                "tag": "Oil stain",
            })
        elif det["category"] == "waste":
            label = det["label"].replace("_", " ")
            if "thread" in label:
                tag = "Thread waste"
            elif "fabric" in label:
                tag = "Fabric waste"
            else:
                tag = "Waste material"
            issues.append({
                "s": "shine",
                "label": f"{tag} detected on floor",
                "severity": "moderate",
                "image_index": det["image_index"],
                "box": det["box"],
                "tag": tag,
            })

    # Low brightness across the board often correlates with dirty / dim
    # working conditions in production zones.
    avg_brightness = sum(m["brightness"]["brightness"] for m in metrics) / max(1, len(metrics))
    if avg_brightness < 55 and zone["category"] in {"Production", "Stores"}:
        issues.append({
            "s": "shine",
            "label": f"Working area appears dim / unclean (brightness {avg_brightness:.0f}/255)",
            "severity": "minor",
            "image_index": 0,
            "box": None,
            "tag": "Dirty floor",
        })

    return issues


# ---------------------------------------------------------------------------
# 4S - STANDARDIZE
# ---------------------------------------------------------------------------

def _check_standardize(detections, metrics, zone) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []

    # Color-coding heuristic - we expect at least two of the safety colours
    # in a zone whose mustHave list mentions colour coding.
    needs_coding = "color_coding" in zone["mustHave"]
    if needs_coding:
        present = [c for c in ("yellow", "red", "green") if any(m["colors"][c] for m in metrics)]
        if len(present) < 2:
            issues.append({
                "s": "standardize",
                "label": "Color-coding (yellow / red / green) not visible",
                "severity": "moderate",
                "image_index": 0,
                "box": None,
                "tag": "No color coding",
            })

    # SOP / signage heuristic - we currently can't reliably detect SOP charts
    # via YOLO COCO, but if the zone *requires* signage and not a single
    # rectangular paper-like area is visible, surface a soft flag. We use the
    # presence of "sign", "book", "paper" or a tall thin rectangle as proxy.
    if "sop_chart" in zone["mustHave"]:
        sop_proxies = sum(1 for d in detections
                          if d["label"] in {"sign", "book", "paper", "monitor"})
        if sop_proxies == 0:
            issues.append({
                "s": "standardize",
                "label": "SOP chart / visual standard not visible",
                "severity": "moderate",
                "image_index": 0,
                "box": None,
                "tag": "No SOP",
            })

    return issues


# ---------------------------------------------------------------------------
# 5S - SUSTAIN
# ---------------------------------------------------------------------------

def _check_sustain(current_issues_by_s, history) -> List[Dict[str, Any]]:
    """
    Sustain rewards consistency over time. We look at:
      * repeated_issues: any tag that appeared in the previous audit AND now
      * declining_trend: total score lower than the previous total
    `history` is a list of previous audit summaries (newest first).
    """
    issues: List[Dict[str, Any]] = []

    if not history:
        return issues  # first audit of this zone - nothing to compare against

    last = history[0]

    # Repeated issues
    last_tags = {i.get("tag") for i in last.get("issues", []) if i.get("tag")}
    current_tags = set()
    for s_issues in current_issues_by_s.values():
        for issue in s_issues:
            tag = issue.get("tag")
            if tag:
                current_tags.add(tag)
    repeated = current_tags & last_tags
    for tag in sorted(repeated):
        issues.append({
            "s": "sustain",
            "label": f"Repeated issue from last audit: {tag}",
            "severity": "moderate",
            "image_index": 0,
            "box": None,
            "tag": "Repeated issue",
        })

    # Declining trend - compare to the last total score, on a /20 basis.
    last_total = last.get("scores", {}).get("total")
    if last_total is not None:
        # Tentatively compute the current total before sustain points are added.
        provisional_total = sum(_bucket_score(_weighted_count(v))
                                for v in current_issues_by_s.values())
        # Allow sustain itself to be a perfect 4 in this provisional sum.
        provisional_total += 4
        if provisional_total < last_total - 1:
            issues.append({
                "s": "sustain",
                "label": f"Declining performance vs last audit ({last_total} -> {provisional_total})",
                "severity": "critical",
                "image_index": 0,
                "box": None,
                "tag": "Declining performance",
            })

    return issues


# ---------------------------------------------------------------------------
# Action point generation
# ---------------------------------------------------------------------------

def _build_action_points(issues_by_s, zone) -> List[str]:
    actions: List[str] = []

    sort_issues = issues_by_s["sort"]
    if any("Forbidden" in i["label"] or "Unrelated" in i["label"] for i in sort_issues):
        actions.append(
            f"Apply the red-tag system in {zone['code']} {zone['name']}: tag, photograph and "
            "remove every item that does not belong in the zone within 24 hours."
        )
    if any("Excess" in i["label"] for i in sort_issues):
        actions.append(
            "Review reorder levels and shift surplus inventory back to the central store; "
            "keep only one shift's worth of stock at the workstation."
        )
    if any("Clutter" in i["label"] for i in sort_issues):
        actions.append(
            "Conduct a 30-minute clean-sweep and remove unused items from work surfaces."
        )

    set_issues = issues_by_s["setInOrder"]
    if any("alignment" in i["label"].lower() for i in set_issues):
        actions.append(
            "Re-mark floor positions with yellow tape (1\" wide) for racks, machines and trolleys "
            "so each item has a clearly outlined home position."
        )
    if any("label" in i["label"].lower() for i in set_issues):
        actions.append(
            "Roll out the labelling system: print durable labels for every rack, bin and shelf "
            "and assign one supervisor as the labelling owner."
        )
    if any("walkway" in i["label"].lower() or "pathway" in i["label"].lower() for i in set_issues):
        actions.append(
            "Clear the main walkway immediately and paint a 1.2 m green border to keep aisles "
            "permanently free of materials."
        )
    if zone["category"] in {"Production", "Stores"}:
        actions.append(
            "Introduce a shadow board for tools used in this zone so missing items are noticed instantly."
        )

    shine_issues = issues_by_s["shine"]
    if any("stain" in i["label"].lower() for i in shine_issues):
        actions.append(
            "Schedule a deep-clean of the floor with degreaser today and identify the source of the leak/spill."
        )
    if any("waste" in i["label"].lower() or "scrap" in i["label"].lower() for i in shine_issues):
        actions.append(
            "Place a dedicated colour-coded waste bin within 2 m of every workstation and empty it every shift."
        )
    if shine_issues:
        actions.append(
            "Assign cleaning responsibility per shift on a 5S responsibility roster displayed in the zone."
        )

    std_issues = issues_by_s["standardize"]
    if any("SOP" in i["label"] for i in std_issues):
        actions.append(
            "Print and laminate the latest SOP for this zone and mount it at eye-level near the entrance."
        )
    if any("color-coding" in i["label"].lower() or "color coding" in i["label"].lower() for i in std_issues):
        actions.append(
            "Apply standard 5S colour coding: yellow for boundaries, red for defectives, green for finished goods."
        )

    sustain_issues = issues_by_s["sustain"]
    if any("Repeated" in i["label"] for i in sustain_issues):
        actions.append(
            "Hold a 15-minute root-cause huddle on the repeated issue and assign a SMART corrective action with owner and due date."
        )
    if any("Declining" in i["label"] for i in sustain_issues):
        actions.append(
            "Escalate to the section manager: introduce a daily 5S walk and a weekly 5S scorecard review."
        )

    if not actions:
        actions.append(f"{zone['code']} {zone['name']} meets 5S standards - continue daily checklists and monthly cross-audits.")

    # De-duplicate while preserving order.
    seen = set()
    deduped = []
    for action in actions:
        if action not in seen:
            seen.add(action)
            deduped.append(action)
    return deduped


# ---------------------------------------------------------------------------
# Summary / remarks
# ---------------------------------------------------------------------------

def _build_summary(zone, scores, issue_count) -> Dict[str, str]:
    total = scores["total"]
    if total >= 18:
        verdict = "Exemplary 5S - this zone can serve as a benchmark for the rest of the plant."
    elif total >= 15:
        verdict = "Good 5S compliance with minor gaps that the team can close within a shift."
    elif total >= 11:
        verdict = "Mixed 5S performance - several issues need structured corrective action."
    elif total >= 7:
        verdict = "Poor 5S performance - the zone needs an immediate red-tag drive and supervisor follow-up."
    else:
        verdict = "Critical 5S failure - shut-down level findings; intervene today before quality issues escalate."

    summary = (
        f"{zone['code']} {zone['name']} (category: {zone['category']}) was audited and scored "
        f"{total}/20 across the five S parameters with {issue_count} distinct issue(s) detected. "
        f"{verdict}"
    )
    return {"summary": summary, "remarks": verdict}


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def evaluate(
    zone_id: str,
    detections: List[Dict[str, Any]],
    per_image_metrics: List[Dict[str, Any]],
    history: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    zone = get_zone(zone_id)

    issues_by_s = {
        "sort":        _check_sort(detections, per_image_metrics, zone),
        "setInOrder":  _check_set_in_order(detections, per_image_metrics, zone),
        "shine":       _check_shine(detections, per_image_metrics, zone),
        "standardize": _check_standardize(detections, per_image_metrics, zone),
        "sustain":     [],  # filled in below
    }

    issues_by_s["sustain"] = _check_sustain(issues_by_s, history or [])

    scores = {
        s: _bucket_score(_weighted_count(items))
        for s, items in issues_by_s.items()
    }
    scores["total"] = sum(scores[s] for s in ("sort", "setInOrder", "shine", "standardize", "sustain"))

    flat_issues: List[Dict[str, Any]] = []
    for s, items in issues_by_s.items():
        for issue in items:
            flat_issues.append(issue)

    summary_block = _build_summary(zone, scores, len(flat_issues))

    # Group annotations by image index so the front-end / PDF can render them.
    annotations_by_image: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for issue in flat_issues:
        if issue.get("box") is not None:
            annotations_by_image[issue["image_index"]].append(issue)
    annotations = [
        {"image_index": idx, "issues": anns}
        for idx, anns in sorted(annotations_by_image.items())
    ]

    status_total = scores["total"]
    if status_total >= 16:
        status = "Green"
    elif status_total >= 11:
        status = "Yellow"
    else:
        status = "Red"

    return {
        "zone": {"id": zone["id"], "code": zone["code"], "name": zone["name"], "category": zone["category"]},
        "scores": scores,
        "issues": flat_issues,
        "issuesByS": issues_by_s,
        "actionPoints": _build_action_points(issues_by_s, zone),
        "summary": summary_block["summary"],
        "remarks": summary_block["remarks"],
        "annotations": annotations,
        "status": status,
    }
