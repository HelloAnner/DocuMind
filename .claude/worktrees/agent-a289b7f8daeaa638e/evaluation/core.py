"""运行上下文、路径、哈希与原子读写。

R = workspace_root/eval/documind/<run_id>/，不随 cwd 漂移。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

# ---------------------------------------------------------------- 时间与标识


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(moment: datetime | None = None) -> str:
    value = (moment or utc_now()).astimezone(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def utc_stamp(moment: datetime | None = None) -> str:
    return (moment or utc_now()).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def new_run_id() -> str:
    return f"{utc_stamp()}-{secrets.token_hex(4)}"


_RUN_ID_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$")


def valid_run_id(run_id: str) -> bool:
    return bool(_RUN_ID_RE.match(run_id or ""))


# ---------------------------------------------------------------- 路径与哈希


def expand_path(value: str | os.PathLike[str]) -> Path:
    raw = os.fspath(value)
    raw = os.path.expandvars(os.path.expanduser(raw))
    return Path(raw).resolve()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_text(json.dumps(value, ensure_ascii=False, sort_keys=True))


# ---------------------------------------------------------------- 原子读写


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def append_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with open(path, "a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=False) + "\n")
            count += 1
    return count


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    count = 0
    with open(tmp, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=False) + "\n")
            count += 1
    os.replace(tmp, path)
    return count


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def iter_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    if not path.exists():
        return
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


# ---------------------------------------------------------------- 运行目录

STAGE_DIRS = (
    "preflight",
    "baseline",
    "corpus",
    "preparation",
    "dataset",
    "raw",
    "normalized",
    "grading",
    "analysis",
    "reports",
    "verification",
    "execution",
)


@dataclass
class RunContext:
    workspace_root: Path
    run_id: str
    root: Path
    manifest: dict[str, Any] = field(default_factory=dict)

    def path(self, *parts: str) -> Path:
        return self.root.joinpath(*parts)

    def stage_dir(self, name: str) -> Path:
        target = self.path(name)
        target.mkdir(parents=True, exist_ok=True)
        return target

    def write_json(self, rel: str, value: Any) -> Path:
        target = self.path(rel)
        atomic_write_json(target, value)
        return target

    def read_json(self, rel: str, default: Any = None) -> Any:
        return read_json(self.path(rel), default)

    def write_jsonl(self, rel: str, rows: Iterable[dict[str, Any]]) -> Path:
        target = self.path(rel)
        write_jsonl(target, rows)
        return target

    def append_jsonl(self, rel: str, rows: Iterable[dict[str, Any]]) -> int:
        return append_jsonl(self.path(rel), rows)

    def read_jsonl(self, rel: str) -> list[dict[str, Any]]:
        return read_jsonl(self.path(rel))

    def save_manifest(self) -> None:
        atomic_write_json(self.path("manifest.json"), self.manifest)

    # ------------------------------------------------------------ 阶段状态

    def stage_status(self, stage: str) -> dict[str, Any]:
        return self.read_json(f"execution/{stage}.json", {}) or {}

    def mark_stage(self, stage: str, status: str, **extra: Any) -> dict[str, Any]:
        record = {
            "stage": stage,
            "status": status,
            "updated_at": utc_iso(),
            **extra,
        }
        if status in ("completed", "failed"):
            record["finished_at"] = utc_iso()
        else:
            record.setdefault("started_at", utc_iso())
        self.write_json(f"execution/{stage}.json", record)
        return record

    def stage_completed(self, stage: str) -> bool:
        return self.stage_status(stage).get("status") == "completed"


def create_run(workspace_root: Path, run_id: str, config_ref: dict[str, Any]) -> RunContext:
    """排他创建运行目录；同 run_id 不覆盖。"""
    if not valid_run_id(run_id):
        raise ValueError(f"非法 run_id: {run_id!r}")
    root = workspace_root / "eval" / "documind" / run_id
    if root.exists():
        raise FileExistsError(f"运行目录已存在，拒绝覆盖: {root}")
    root.mkdir(parents=True)
    for name in STAGE_DIRS:
        (root / name).mkdir()
    ctx = RunContext(workspace_root=workspace_root, run_id=run_id, root=root)
    ctx.manifest = {
        "system": "DocuMind",
        "run_id": run_id,
        "created_at": utc_iso(),
        "workspace_root": str(workspace_root),
        "run_root": str(root),
        "config_ref": config_ref,
        "status": "running",
    }
    ctx.save_manifest()
    return ctx


def load_run(workspace_root: Path, run_id: str) -> RunContext:
    if not valid_run_id(run_id):
        raise ValueError(f"非法 run_id: {run_id!r}")
    root = workspace_root / "eval" / "documind" / run_id
    if not root.is_dir():
        raise FileNotFoundError(f"运行目录不存在: {root}")
    manifest = read_json(root / "manifest.json", {}) or {}
    return RunContext(workspace_root=workspace_root, run_id=run_id, root=root, manifest=manifest)


def latest_run_id(workspace_root: Path) -> str | None:
    base = workspace_root / "eval" / "documind"
    if not base.is_dir():
        return None
    candidates = sorted(
        (entry.name for entry in base.iterdir() if entry.is_dir() and valid_run_id(entry.name)),
        reverse=True,
    )
    return candidates[0] if candidates else None
