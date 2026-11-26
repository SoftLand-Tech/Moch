#!/usr/bin/env python3
"""Generate docs/bug-hunter/findings.md from findings.jsonl (discovery events + later status events)."""
import json, sys, datetime

src, dst = sys.argv[1], sys.argv[2]
records = [json.loads(l) for l in open(src) if l.strip()]
discoveries = [r for r in records if r.get("event_type") == "finding_discovered"]
others = [r for r in records if r.get("event_type") != "finding_discovered"]

# current status = latest status among discovery + events referencing it
status_of, anno = {}, {}
for r in discoveries:
    status_of[r["event_id"]] = r
for r in others:
    sid = r.get("subject_finding")
    if sid:
        if r.get("event_type") == "finding_annotated":
            anno.setdefault(sid, []).append(r)
        elif r.get("event_type") == "status_change" and r.get("to_status"):
            merged = dict(status_of.get(sid, {})); merged["status"] = r["to_status"]; status_of[sid] = merged
        elif "status" in r:
            status_of[sid] = r

sev_order = {"critical":0,"high":1,"medium":2,"low":3,"informational":4}
rows = []
for d in discoveries:
    cur = status_of[d["event_id"]]
    rows.append({
        "id": d["event_id"], "title": d["title"].split(": ",1)[-1],
        "sev": d.get("severity","informational"), "conf": d.get("confidence","?"),
        "status": cur.get("status", d.get("status")), "file": d.get("file",""),
        "line": d.get("line"), "source": d.get("source",""),
        "rel": [x for x in d.get("related_ids",[]) if x],
        "gh": d.get("github_issue_url"), "ev": d.get("evidence",[]),
        "repro": d.get("reproduction_steps",[]), "rem": d.get("suggested_remediation") or d.get("resolution"),
        "detail": d.get("detail") or "", "annos": anno.get(d["event_id"], []),
    })
rows.sort(key=lambda r: (sev_order.get(r["sev"],9), r["id"]))

sev_labels = {"critical":"🔴 Critical","high":"🟠 High","medium":"🟡 Medium","low":"🟢 Low","informational":"ℹ️ Informational"}
counts = {}
for r in rows: counts[r["sev"]] = counts.get(r["sev"],0)+1
st_counts = {}
for r in rows: st_counts[r["status"]] = st_counts.get(r["status"],0)+1

out = []
out.append("# Findings Index — Moch Bug-Hunter Audit (round 1)\n")
out.append(f"Generated from `findings.jsonl` ({len(records)} events, {len(discoveries)} findings). ")
out.append("Historical discovery events are preserved in the JSONL; this index reflects **current** statuses.\n")
out.append(f"**Severity mix:** " + " · ".join(f"{sev_labels[k].split(' ')[1]} {counts[k]}" for k in ["critical","high","medium","low","informational"] if k in counts))
out.append(f"\n**Status mix:** " + " · ".join(f"{k} {v}" for k,v in sorted(st_counts.items())) + "\n")
out.append("| ID | Sev | Conf | Status | Title | File |")
out.append("|---|---|---|---|---|---|")
for r in rows:
    f = f"`{r['file']}{'>'+str(r['line']) if r['line'] else ''}`" if r["file"] else "—"
    out.append(f"| {r['id']} | {r['sev']} | {r['conf']} | {r['status']} | {r['title'][:110]} | {f} |")
out.append("")
for r in rows:
    out.append(f"\n## {r['id']} — {r['title']}\n")
    out.append(f"- **Severity:** {r['sev']} · **Confidence:** {r['conf']} · **Status:** {r['status']} · **Source:** {r['source']}")
    if r["file"]:
        out.append(f"- **Location:** `{r['file']}`" + (f" line ~{r['line']}" if r["line"] else ""))
    if r["rel"]:
        out.append(f"- **Related:** {', '.join(r['rel'])}")
    if r["gh"]:
        out.append(f"- **GitHub:** {r['gh']}")
    if r["detail"]:
        out.append(f"- **Failure scenario:** {r['detail']}")
    for e in r["ev"][:6]:
        if e: out.append(f"  - Evidence: {e}")
    for step in r["repro"][:4]:
        out.append(f"  - Repro: {step}")
    if isinstance(r["rem"], dict):
        out.append(f"- **Resolution:** {r['rem'].get('kind','')} — {r['rem'].get('ref','')} ({r['rem'].get('note','')})")
    elif r["rem"]:
        out.append(f"- **Remediation:** {r['rem']}")
    for a in r["annos"]:
        out.append(f"- **Annotation ({a.get('annotation')}):** {a.get('detail')}")
open(dst,"w").write("\n".join(out) + "\n")
print(f"wrote {dst}: {len(rows)} findings from {len(records)} events")
