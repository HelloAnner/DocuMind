"""运行配置：内置默认值 + 显式 JSON 覆盖 + 脱敏解析结果。

禁止在配置或日志中落盘明文密钥；密钥只按环境引用读取。
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

from .core import expand_path, sha256_text, utc_iso

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKSPACE_ROOT = REPO_ROOT.parent

DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "system": "DocuMind",
    "workspace_root": str(DEFAULT_WORKSPACE_ROOT),
    "cli": {
        "binary": str(REPO_ROOT / "cli" / "dist" / "documind"),
        "password_file": "~/.config/documind/password.env",
        "password_var": "DOCUMIND_PASSWORD",
        "server_url": "http://123.57.255.204:8089",
        "ssh_host": "documind",
        "timeout_seconds": 420,
    },
    "isolation": {
        "mode": "tenant_namespace",
        "tenant_slug_prefix": "dm-eval",
        "tenant_name_prefix": "DocuMind Eval",
        "plan": "trial",
        "retain": False,
    },
    "models": {
        "provider": {
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "api_key_file": "~/.config/documind/llm.env",
            "api_key_var": "LLM_API",
            "request_timeout_seconds": 180,
            "max_retries": 3,
        },
        "profiles": {
            "generate": {"model": "qwen3.8-max-0902", "max_tokens": 4000, "temperature": 0.0},
            "judge_basic": {"model": "qwen3.8-max-0902", "max_tokens": 3000, "temperature": 0.0},
            "judge_complex": {"model": "qwen3.8-max-0902", "max_tokens": 4000, "temperature": 0.0},
            "adjudicate": {"model": "deepseek-v4-pro-0813", "max_tokens": 4000, "temperature": 0.0},
            "narrate": {"model": "qwen3.8-max-0902", "max_tokens": 4000, "temperature": 0.0},
        },
    },
    "budget": {
        "max_model_calls": 1500,
        "max_model_tokens": 20_000_000,
        "max_cli_calls": 800,
    },
    "run": {
        "trial_k": 1,
        "stability_case_limit": 8,
        "max_questions": 34,
        "case_limit": 0,
        "seed": 20261010,
        "question_generation": True,
        "case_validation": True,
        "blind_review": True,
        "blind_review_limit": 12,
    },
    "grading": {
        "severity_rules": {},
        "default_severity": "minor",
    },
    "report": {
        "title": "DocuMind 文档问答准确性评估报告",
        "public": False,
    },
}


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def load_config(config_path: str | Path | None) -> dict[str, Any]:
    merged = copy.deepcopy(DEFAULT_CONFIG)
    source_path: Path | None = None
    if config_path:
        source_path = expand_path(config_path)
        payload = json.loads(source_path.read_text(encoding="utf-8"))
        merged = _deep_merge(merged, payload)
    merged["_source"] = str(source_path) if source_path else "builtin"
    merged["_loaded_at"] = utc_iso()
    return merged


def read_secret(env_file: str | Path, var: str) -> str:
    """从只读环境文件读取密钥；不落盘、不回显。"""
    direct = os.environ.get(var)
    if direct:
        return direct.strip()
    path = expand_path(env_file)
    if not path.exists():
        raise FileNotFoundError(f"密钥文件不存在: {path}")
    value = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, raw = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        if key == var:
            value = raw.strip().strip("'").strip('"')
    if not value:
        raise ValueError(f"密钥文件中没有 {var}: {path}")
    return value


def resolved_view(config: dict[str, Any]) -> dict[str, Any]:
    """生成脱敏、可冻结的配置视图。"""
    view = copy.deepcopy(config)
    view.pop("_source", None)
    cli = view.get("cli", {})
    cli["password_file"] = str(expand_path(cli["password_file"]))
    provider = view.get("models", {}).get("provider", {})
    provider["api_key_file"] = str(expand_path(provider["api_key_file"]))
    provider["api_key"] = "<redacted>"
    view["_resolved_at"] = utc_iso()
    return view


def config_hash(config: dict[str, Any]) -> str:
    return sha256_text(json.dumps(config, ensure_ascii=False, sort_keys=True))


def profile(config: dict[str, Any], role: str) -> dict[str, Any]:
    profiles = config.get("models", {}).get("profiles", {})
    if role not in profiles:
        raise KeyError(f"未配置模型角色: {role}")
    profile_value = dict(profiles[role])
    profile_value["role"] = role
    return profile_value
