#!/usr/bin/env python3
"""Verify docs/pr packet spec.lock.json against canonical infra-docs content."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Optional

import spec_lock


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def discover_latest_packet(root: Path) -> Optional[Path]:
    base = root / "docs" / "pr"
    if not base.exists():
        return None

    candidates = []
    for path in base.glob("PR-*"):
        match = re.match(r"PR-(\d+)", path.name)
        if match:
            candidates.append((int(match.group(1)), path))
    if not candidates:
        return None

    return sorted(candidates, key=lambda item: item[0])[-1][1]


def resolve_packet_dir(root: Path, packet_arg: Optional[str], pr_num: Optional[int]) -> Optional[Path]:
    if packet_arg:
        path = Path(packet_arg)
        if not path.is_absolute():
            path = root / path
        return path

    if pr_num is None:
        env_pr = os.getenv("PR_NUM")
        if env_pr and env_pr.isdigit():
            pr_num = int(env_pr)

    if pr_num is not None:
        return root / "docs" / "pr" / f"PR-{pr_num:03d}"

    return discover_latest_packet(root)


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify packet spec.lock.json drift")
    parser.add_argument("packet", nargs="?", default=None, help="Explicit packet dir path")
    parser.add_argument("--pr-num", type=int, default=None)
    args = parser.parse_args()

    root = repo_root()
    packet_dir = resolve_packet_dir(root, args.packet, args.pr_num)
    if packet_dir is None:
        print("No spec.lock.json found; skipping spec verification")
        return 0

    lock_path = packet_dir / "spec.lock.json"
    if not lock_path.exists():
        print("No spec.lock.json found; skipping spec verification")
        return 0

    lock_data = json.loads(lock_path.read_text(encoding="utf-8"))
    infra_docs_root = os.getenv("INFRA_DOCS_ROOT")

    def content_loader(relpath: str) -> str:
        return spec_lock.load_canonical_text(
            infra_repo=str(lock_data["infra_repo"]),
            infra_sha=str(lock_data["infra_sha"]),
            relpath=relpath,
            infra_docs_root=infra_docs_root,
        )

    result = spec_lock.verify_spec_lock(lock_data, content_loader)
    exit_code, message = spec_lock.decide_exit_code(result)

    if result.ok:
        print(f"Spec verification PASS for {lock_path}")
        return 0

    print(message)
    for mismatch in result.mismatches:
        print(
            "- "
            f"{mismatch['path']}: expected {mismatch['expected']} actual {mismatch['actual']}"
        )

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
