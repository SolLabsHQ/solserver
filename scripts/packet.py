#!/usr/bin/env python3
import os, re, json, pathlib, sys
from typing import Optional, Dict

def repo_root() -> str:
    import subprocess
    try:
        out = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], stderr=subprocess.DEVNULL)
        return out.decode().strip()
    except Exception:
        return os.getcwd()

def find_packets(root: str) -> Dict[int, str]:
    base = pathlib.Path(root) / "docs" / "pr"
    if not base.exists():
        return {}
    packets = {}
    for p in base.glob("PR-*"):
        m = re.match(r"PR-(\d+)", p.name)
        if not m:
            continue
        prn = int(m.group(1))
        if (p / "AGENTPACK.md").exists():
            packets[prn] = str(p)
    return packets

def pick_packet(root: str, pr_num: Optional[int]) -> str:
    packets = find_packets(root)
    if pr_num is not None:
        if pr_num in packets:
            return packets[pr_num]
        raise SystemExit(f"Packet not found for PR-{pr_num}. Expected docs/pr/PR-{pr_num:03d}/AGENTPACK.md or PR-{pr_num}.")
    if not packets:
        raise SystemExit("No packets found under docs/pr/PR-*/AGENTPACK.md. Create docs/pr/PR-042/AGENTPACK.md etc.")
    return packets[max(packets.keys())]

def main():
    root = repo_root()
    pr_num = os.getenv("PR_NUM")
    pr_num_i = int(pr_num) if pr_num and pr_num.isdigit() else None
    packet_dir = pick_packet(root, pr_num_i)
    p = pathlib.Path(packet_dir)
    out = {
        "repo_root": root,
        "packet_dir": str(p),
        "agentpack": str(p / "AGENTPACK.md"),
        "input": str(p / "INPUT.md"),
        "checklist": str(p / "CHECKLIST.md"),
        "fixlog": str(p / "FIXLOG.md"),
        "receipts_dir": str(p / "receipts"),
    }
    pathlib.Path(out["receipts_dir"]).mkdir(parents=True, exist_ok=True)
    print(json.dumps(out))
if __name__ == "__main__":
    main()
