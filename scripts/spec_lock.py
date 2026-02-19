#!/usr/bin/env python3
"""Shared helpers for canonical spec anchors, lock generation, and drift verification."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

CANONICAL_ANCHOR_TAG = "canonical-spec-anchor"


@dataclass
class VerificationResult:
    ok: bool
    mismatches: List[Dict[str, str]]


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def sha256_normalized_text(text: str) -> str:
    normalized = normalize_newlines(text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def load_manifest(path: Path | str) -> Dict[str, object]:
    manifest_path = Path(path)
    data = json.loads(manifest_path.read_text(encoding="utf-8"))

    required = ["epic", "infra_repo", "infra_sha", "pr_map", "canonical_files"]
    missing = [key for key in required if key not in data]
    if missing:
        raise ValueError(f"Manifest missing required keys: {', '.join(missing)}")

    canonical_files = data.get("canonical_files")
    if not isinstance(canonical_files, list) or not canonical_files:
        raise ValueError("Manifest canonical_files must be a non-empty array")
    if not all(isinstance(path_item, str) and path_item.strip() for path_item in canonical_files):
        raise ValueError("Manifest canonical_files entries must be non-empty strings")

    if not isinstance(data.get("pr_map"), dict):
        raise ValueError("Manifest pr_map must be an object")

    return data


def render_canonical_spec_anchor(manifest: Dict[str, object]) -> str:
    infra_repo = str(manifest["infra_repo"])
    infra_sha = str(manifest["infra_sha"])
    epic = str(manifest["epic"])
    canonical_files = list(manifest["canonical_files"])

    lines = [
        "<!-- BEGIN GENERATED: canonical-spec-anchor -->",
        "## Canonical Spec Anchor (infra-docs)",
        f"- Epic: {epic}",
        f"- Canonical repo: {infra_repo}",
        f"- Canonical commit: {infra_sha}",
        f"- Canonical epic path: codex/epics/{epic}/",
        "- Canonical files:",
    ]
    for relpath in canonical_files:
        relpath_str = str(relpath)
        lines.append(
            f"  - {relpath_str} (https://github.com/{infra_repo}/blob/{infra_sha}/{relpath_str})"
        )

    lines.extend(
        [
            "Notes:",
            "- If you have a local checkout, set INFRA_DOCS_ROOT to verify locally.",
            "- Otherwise CI will verify via GitHub at the pinned commit.",
            "<!-- END GENERATED: canonical-spec-anchor -->",
        ]
    )
    return "\n".join(lines)


def upsert_generated_block(document_text: str, tag: str, rendered_block: str) -> str:
    begin = f"<!-- BEGIN GENERATED: {tag} -->"
    end = f"<!-- END GENERATED: {tag} -->"
    pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.DOTALL)

    if pattern.search(document_text):
        return pattern.sub(rendered_block, document_text, count=1)

    if document_text.strip():
        return document_text.rstrip() + "\n\n" + rendered_block + "\n"

    return rendered_block + "\n"


def generate_spec_lock(
    manifest: Dict[str, object],
    content_loader: Callable[[str], str],
    generated_at: Optional[str] = None,
    generator_name: str = "scaffold_pr_packets.py",
    generator_version: str = "dev",
) -> Dict[str, object]:
    if generated_at is None:
        generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    canonical_entries: List[Dict[str, str]] = []
    for relpath in manifest["canonical_files"]:
        relpath_str = str(relpath)
        text = content_loader(relpath_str)
        canonical_entries.append(
            {
                "path": relpath_str,
                "sha256": sha256_normalized_text(text),
            }
        )

    return {
        "schema_version": 1,
        "epic": str(manifest["epic"]),
        "generated_at": generated_at,
        "infra_repo": str(manifest["infra_repo"]),
        "infra_sha": str(manifest["infra_sha"]),
        "canonical_files": canonical_entries,
        "generator": {
            "name": generator_name,
            "version": generator_version,
        },
    }


def verify_spec_lock(
    lock_data: Dict[str, object],
    content_loader: Callable[[str], str],
) -> VerificationResult:
    mismatches: List[Dict[str, str]] = []
    canonical_entries = lock_data.get("canonical_files", [])

    for entry in canonical_entries:
        relpath = str(entry.get("path", ""))
        expected = str(entry.get("sha256", ""))

        try:
            actual = sha256_normalized_text(content_loader(relpath))
        except Exception as exc:  # pragma: no cover - surfaced in mismatch output
            mismatches.append(
                {
                    "path": relpath,
                    "expected": expected,
                    "actual": f"<error: {exc}>",
                }
            )
            continue

        if actual != expected:
            mismatches.append(
                {
                    "path": relpath,
                    "expected": expected,
                    "actual": actual,
                }
            )

    return VerificationResult(ok=len(mismatches) == 0, mismatches=mismatches)


def decide_exit_code(result: VerificationResult) -> Tuple[int, str]:
    if result.ok:
        return 0, "Spec verification PASS."
    if os.getenv("ALLOW_SPEC_DRIFT") == "1":
        return 0, "Spec drift detected, but ALLOW_SPEC_DRIFT=1 so continuing with warning."
    return 1, "Spec drift detected. Set ALLOW_SPEC_DRIFT=1 to bypass."


def get_git_short_sha(repo_root: Path | str) -> str:
    root = Path(repo_root)
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()
    except Exception:
        return "dev"


def read_local_canonical_text(infra_docs_root: Path | str, relpath: str) -> str:
    root = Path(infra_docs_root)
    path = root / relpath
    if not path.exists():
        raise FileNotFoundError(f"Canonical file not found at {path}")
    return path.read_text(encoding="utf-8")


def fetch_via_gh_api(infra_repo: str, relpath: str, infra_sha: str) -> str:
    if not shutil.which("gh"):
        raise RuntimeError("gh CLI is not available")

    endpoint_path = quote(relpath, safe="/")
    endpoint = f"repos/{infra_repo}/contents/{endpoint_path}?ref={infra_sha}"
    completed = subprocess.run(
        ["gh", "api", endpoint],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or "gh api failed"
        raise RuntimeError(error_text)

    payload = json.loads(completed.stdout)
    if payload.get("encoding") != "base64" or "content" not in payload:
        raise RuntimeError("Unexpected gh api response; expected base64 content")

    decoded = base64.b64decode(payload["content"])
    return decoded.decode("utf-8")


def fetch_via_raw_github(infra_repo: str, relpath: str, infra_sha: str) -> str:
    encoded_path = quote(relpath, safe="/")
    url = f"https://raw.githubusercontent.com/{infra_repo}/{infra_sha}/{encoded_path}"
    headers = {"Accept": "text/plain"}
    token = os.getenv("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = Request(url, headers=headers)
    try:
        with urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8")
    except HTTPError as exc:
        raise RuntimeError(f"raw.githubusercontent.com HTTP {exc.code} for {relpath}") from exc
    except URLError as exc:
        raise RuntimeError(f"Failed to fetch {relpath} from raw.githubusercontent.com: {exc}") from exc


def load_canonical_text(
    infra_repo: str,
    infra_sha: str,
    relpath: str,
    infra_docs_root: Optional[str] = None,
) -> str:
    if infra_docs_root:
        root = Path(infra_docs_root)
        if not root.exists() or not root.is_dir():
            raise RuntimeError(f"INFRA_DOCS_ROOT does not point to a valid directory: {infra_docs_root}")
        return read_local_canonical_text(root, relpath)

    gh_error: Optional[Exception] = None
    try:
        return fetch_via_gh_api(infra_repo, relpath, infra_sha)
    except Exception as exc:
        gh_error = exc

    try:
        return fetch_via_raw_github(infra_repo, relpath, infra_sha)
    except Exception as raw_exc:
        if gh_error is not None:
            raise RuntimeError(f"gh fetch failed ({gh_error}); raw fetch failed ({raw_exc})") from raw_exc
        raise


def write_json(path: Path | str, payload: Dict[str, object]) -> None:
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
