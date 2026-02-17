#!/usr/bin/env python3
import re, sys, pathlib, datetime
from typing import Dict

def update_checklist_evidence(checklist_path: str, updates: Dict[str, Dict[str,str]]) -> None:
    p = pathlib.Path(checklist_path)
    text = p.read_text(encoding="utf-8")
    lines = text.splitlines()
    out = []
    for line in lines:
        m = re.match(
            r"(\s*)-\s*\[[xX ]\]\s*(unit|lint|integration)\s*\(AUTO\)\s*—\s*Evidence:\s*(.*)$",
            line,
        )
        if m:
            indent, gate = m.group(1), m.group(2)
            if gate in updates:
                u = updates[gate]
                mark = "x" if u["result"].startswith("PASS") else " "
                ev = f'Command: `{u["cmd"]}` | Result: {u["result"]} | Log: `{u["log"]}`'
                out.append(f"{indent}- [{mark}] {gate} (AUTO) — Evidence: {ev}")
                continue
        out.append(line)
    p.write_text("\n".join(out) + "\n", encoding="utf-8")

def append_fixlog(fixlog_path: str, block: str) -> None:
    p = pathlib.Path(fixlog_path)
    text = p.read_text(encoding="utf-8") if p.exists() else ""
    if not text.endswith("\n"):
        text += "\n"
    p.write_text(text + block + "\n", encoding="utf-8")

def verifier_report_block(status: str, cmds: str, results: str, gaps: str) -> str:
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    return (
        f"## Verifier Report ({ts})\n"
        f"- Status: {status}\n"
        f"- Commands run:\n{cmds}\n"
        f"- Results:\n{results}\n"
        f"- Checklist gaps / notes:\n{gaps}\n"
    )

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "checklist":
        checklist = sys.argv[2]
        import json
        updates = json.loads(sys.argv[3])
        update_checklist_evidence(checklist, updates)
    elif cmd == "fixlog_append":
        fixlog = sys.argv[2]
        block = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")
        append_fixlog(fixlog, block)
    elif cmd == "verifier_report":
        fixlog = sys.argv[2]
        status = sys.argv[3]
        cmds = pathlib.Path(sys.argv[4]).read_text(encoding="utf-8")
        results = pathlib.Path(sys.argv[5]).read_text(encoding="utf-8")
        gaps = pathlib.Path(sys.argv[6]).read_text(encoding="utf-8")
        append_fixlog(fixlog, verifier_report_block(status, cmds, results, gaps))
    else:
        raise SystemExit(f"Unknown cmd: {cmd}")
