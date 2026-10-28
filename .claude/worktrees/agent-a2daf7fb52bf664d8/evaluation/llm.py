"""模型调用层：角色 profile、严格 JSON 解析、重试、预算与调用台账。

密钥只从环境文件读取；台账只记录脱敏身份与 hash，不落盘密钥。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from .config import profile as role_profile, read_secret
from .core import append_jsonl, sha256_text, utc_iso


# 提示词角色 -> 模型能力档（G/W/S/H 的配置映射）
PROFILE_BY_ROLE: dict[str, str] = {
    "fact_extract": "generate",
    "question_generate": "generate",
    "simulate_user": "generate",
    "extract_claims": "generate",
    "case_validate": "judge_basic",
    "judge_parse_semantics": "judge_basic",
    "judge_relevance": "judge_basic",
    "judge_fact_correctness": "judge_complex",
    "judge_faithfulness": "judge_basic",
    "judge_completeness": "judge_basic",
    "judge_citation": "judge_basic",
    "judge_behavior": "judge_basic",
    "judge_dialogue": "judge_complex",
    "review_blind": "adjudicate",
    "review_reconcile": "adjudicate",
    "narrate": "narrate",
}


class BudgetExceeded(RuntimeError):
    pass


class ModelOutputError(RuntimeError):
    pass


@dataclass
class ModelCall:
    role: str
    model: str
    phase: str
    system: str
    user: str
    text: str
    payload: Any
    usage: dict[str, Any]
    attempts: int
    duration_ms: int
    request_id: str | None = None
    error: str | None = None

    def ledger_row(self) -> dict[str, Any]:
        return {
            "at": utc_iso(),
            "role": self.role,
            "model": self.model,
            "phase": self.phase,
            "attempts": self.attempts,
            "duration_ms": self.duration_ms,
            "usage": self.usage,
            "system_sha256": sha256_text(self.system),
            "user_sha256": sha256_text(self.user),
            "response_sha256": sha256_text(self.text),
            "request_id": self.request_id,
            "error": self.error,
            "payload_status": "parsed" if self.payload is not None else "unparsed",
        }


def _extract_json(text: str) -> Any:
    """从模型输出中取出唯一 JSON 对象；拒绝 Markdown 说明。"""
    body = text.strip()
    if body.startswith("```"):
        lines = body.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        body = "\n".join(lines).strip()
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        pass
    start = body.find("{")
    if start < 0:
        raise ModelOutputError("输出中没有 JSON 对象")
    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(body)):
        ch = body[index]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = body[start : index + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError as exc:
                    raise ModelOutputError(f"JSON 解析失败: {exc}") from exc
    raise ModelOutputError("JSON 对象未闭合")


@dataclass
class ModelRouter:
    config: dict[str, Any]
    ledger_path: Any
    calls: int = 0
    tokens: int = 0
    errors: int = 0
    _cache: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        provider = self.config["models"]["provider"]
        self.base_url = provider["base_url"].rstrip("/")
        self.api_key = read_secret(provider["api_key_file"], provider["api_key_var"])
        self.request_timeout = int(provider.get("request_timeout_seconds", 180))
        budget = self.config.get("budget", {})
        self.max_calls = int(budget.get("max_model_calls", 400))
        self.max_tokens = int(budget.get("max_model_tokens", 6_000_000))

    # ------------------------------------------------------------ 调用

    def call(
        self,
        role: str,
        system: str,
        user: str,
        *,
        phase: str,
        max_tokens: int | None = None,
        temperature: float | None = None,
        attempts: int = 3,
        cache: bool = False,
    ) -> ModelCall:
        cache_key = sha256_text(role + "\u0000" + system + "\u0000" + user)
        if cache and cache_key in self._cache:
            return self._cache[cache_key]
        spec = role_profile(self.config, PROFILE_BY_ROLE.get(role, role))
        model = spec["model"]
        model_max = int(max_tokens or spec.get("max_tokens", 3000))
        temp = float(temperature if temperature is not None else spec.get("temperature", 0.0))
        provider = self.config["models"]["provider"]
        max_retries = int(provider.get("max_retries", 3))
        if self.calls >= self.max_calls:
            raise BudgetExceeded(f"模型调用预算耗尽：{self.max_calls}")
        if self.tokens >= self.max_tokens:
            raise BudgetExceeded(f"模型 token 预算耗尽：{self.max_tokens}")

        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": model_max,
            "temperature": temp,
            "enable_thinking": False,
        }
        last_error = ""
        for attempt in range(1, attempts + 1):
            started = time.monotonic()
            self.calls += 1
            try:
                request = urllib.request.Request(
                    f"{self.base_url}/chat/completions",
                    data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=self.request_timeout) as response:
                    raw = json.loads(response.read().decode("utf-8"))
                duration_ms = int((time.monotonic() - started) * 1000)
                message = (raw.get("choices") or [{}])[0].get("message") or {}
                text = message.get("content") or ""
                usage = raw.get("usage") or {}
                self.tokens += int(usage.get("total_tokens") or 0)
                payload = None
                error = None
                try:
                    payload = _extract_json(text)
                except ModelOutputError as exc:
                    error = str(exc)
                call = ModelCall(
                    role=role, model=model, phase=phase, system=system, user=user,
                    text=text, payload=payload, usage=usage, attempts=attempt,
                    duration_ms=duration_ms, request_id=raw.get("id"), error=error,
                )
                if payload is None:
                    last_error = error or "空输出"
                    self.errors += 1
                    if attempt < attempts and attempt <= max_retries:
                        time.sleep(min(2 ** attempt, 8))
                        continue
                append_jsonl(self.ledger_path, [call.ledger_row()])
                if cache:
                    self._cache[cache_key] = call
                return call
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                self.errors += 1
                if attempt < attempts:
                    time.sleep(min(2 ** attempt, 8))
                    continue
                call = ModelCall(
                    role=role, model=model, phase=phase, system=system, user=user,
                    text="", payload=None, usage={}, attempts=attempt,
                    duration_ms=int((time.monotonic() - started) * 1000), error=last_error,
                )
                append_jsonl(self.ledger_path, [call.ledger_row()])
                return call
        raise ModelOutputError(last_error or "模型调用失败")

    def stats(self) -> dict[str, Any]:
        return {"calls": self.calls, "tokens": self.tokens, "errors": self.errors}
