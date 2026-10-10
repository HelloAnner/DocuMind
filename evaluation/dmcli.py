"""DocuMind CLI 适配层：所有业务操作只经真实 CLI，不直连内部 HTTP/数据库。"""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from .core import append_jsonl, expand_path, sha256_text, utc_iso


@dataclass
class CLIResult:
    argv: list[str]
    returncode: int
    stdout: str
    stderr: str
    duration_ms: int
    numeric_parse_error: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    def json(self) -> Any:
        text = self.stdout.strip()
        if not text:
            return None
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end < start:
            start = text.find("[")
            end = text.rfind("]")
        if start < 0 or end < start:
            return None
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None

    def summary(self) -> dict[str, Any]:
        return {
            "argv": self.argv,
            "returncode": self.returncode,
            "duration_ms": self.duration_ms,
            "stdout_sha256": sha256_text(self.stdout),
            "stderr_sha256": sha256_text(self.stderr),
        }


class DocuMindCLI:
    """带独立配置与会话的 CLI 客户端；运行产物与调用台账只写 R。"""

    def __init__(
        self,
        binary: Path,
        config_path: Path,
        password: str,
        *,
        server_url: str,
        cwd: Path,
        timeout_seconds: int = 420,
        ledger_path: Path | None = None,
        max_cli_calls: int | None = None,
        password_env: str = "DOCUMIND_PASSWORD",
    ) -> None:
        self.binary = Path(binary)
        self.config_path = Path(config_path)
        self._password = password
        self.password_env = password_env
        self.server_url = server_url
        self.cwd = Path(cwd)
        self.timeout_seconds = timeout_seconds
        self.ledger_path = ledger_path
        self.max_cli_calls = max_cli_calls
        self.calls = 0

    # ------------------------------------------------------------ 基础调用

    def run(self, args: Sequence[str], *, timeout: int | None = None, check: bool = False) -> CLIResult:
        if self.max_cli_calls is not None and self.calls >= self.max_cli_calls:
            raise RuntimeError(f"CLI 调用预算耗尽（{self.max_cli_calls}）")
        argv = [str(self.binary), "--config", str(self.config_path), *[str(a) for a in args]]
        env = dict(os.environ)
        env["DOCUMIND_PASSWORD"] = self._password
        env[self.password_env] = self._password
        started = time.monotonic()
        try:
            proc = subprocess.run(
                argv,
                cwd=str(self.cwd),
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout or self.timeout_seconds,
            )
            returncode = proc.returncode
            stdout, stderr = proc.stdout, proc.stderr
            timed_out = False
        except subprocess.TimeoutExpired as exc:
            returncode = 124
            stdout = (exc.stdout or b"").decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr = (exc.stderr or b"").decode("utf-8", "replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            stderr += f"\n[timeout after {timeout or self.timeout_seconds}s]"
            timed_out = True
        duration_ms = int((time.monotonic() - started) * 1000)
        result = CLIResult(argv=list(argv), returncode=returncode, stdout=stdout, stderr=stderr, duration_ms=duration_ms)
        self.calls += 1
        if self.ledger_path is not None:
            append_jsonl(self.ledger_path, [{**result.summary(), "at": utc_iso(), "timed_out": timed_out}])
        if check and not result.ok:
            raise RuntimeError(f"CLI 失败 ({returncode}): {' '.join(argv)}\n{stderr[:2000]}")
        return result

    # ------------------------------------------------------------ 认证

    def login(self) -> CLIResult:
        return self.run(["auth", "login"], check=True)

    def whoami(self) -> CLIResult:
        return self.run(["auth", "whoami", "--json"])

    def health(self) -> CLIResult:
        return self.run(["health", "--json"])

    # ------------------------------------------------------------ 租户与权限

    def tenant_create(self, name: str, slug: str, plan: str) -> CLIResult:
        return self.run(["system", "tenant-create", "--name", name, "--slug", slug, "--plan", plan, "--json"])

    def tenant_delete(self, tenant_id: str, slug: str) -> CLIResult:
        return self.run(["system", "tenant-delete", tenant_id, "--slug", slug, "--force", "--json"])

    def invitation_accept(self, token: str) -> CLIResult:
        return self.run(["invitation", "accept", "--token", token, "--json"])

    def auth_tenants(self) -> CLIResult:
        return self.run(["auth", "tenants", "--json"])

    def auth_switch(self, tenant_id: str) -> CLIResult:
        return self.run(["auth", "switch", tenant_id, "--json"])

    # ------------------------------------------------------------ 知识库与文档

    def kb_create(self, name: str, description: str) -> CLIResult:
        return self.run(["kb", "create", "--name", name, "--description", description, "--json"])

    def kb_list(self) -> CLIResult:
        return self.run(["kb", "list", "--json"])

    def kb_delete(self, kb_id: str) -> CLIResult:
        return self.run(["kb", "delete", kb_id, "--force", "--json"])

    def documents_upload(self, path: Path, kb_id: str, timeout_seconds: int) -> CLIResult:
        return self.run(
            ["documents", "upload", str(path), "--kb", kb_id, "--wait", "--timeout", str(timeout_seconds), "--json"],
            timeout=timeout_seconds + 60,
        )

    def documents_list(self, kb_id: str) -> CLIResult:
        return self.run(["documents", "list", "--kb", kb_id, "--json"])

    def documents_show(self, doc_id: str) -> CLIResult:
        return self.run(["documents", "show", doc_id, "--json"])

    def documents_chunks(self, doc_id: str) -> CLIResult:
        return self.run(["documents", "chunks", doc_id, "--json"])

    def documents_blocks(self, doc_id: str) -> CLIResult:
        return self.run(["documents", "blocks", doc_id, "--json"])

    def documents_cleaned_blocks(self, doc_id: str) -> CLIResult:
        return self.run(["documents", "cleaned-blocks", doc_id, "--json"])

    def documents_tables(self, doc_id: str) -> CLIResult:
        return self.run(["documents", "tables", doc_id, "--json"])

    def documents_job(self, job_id: str) -> CLIResult:
        return self.run(["documents", "job", job_id, "--json"])

    def documents_delete(self, doc_id: str) -> CLIResult:
        return self.run(["documents", "delete", doc_id, "--force", "--json"])

    def documents_ocr(self, doc_id: str, timeout_seconds: int) -> CLIResult:
        return self.run(["documents", "ocr", doc_id, "--wait", "--timeout", str(timeout_seconds), "--json"],
                        timeout=timeout_seconds + 60)

    # ------------------------------------------------------------ 对话与 trace

    def chat(
        self,
        question: str,
        kb_ids: Sequence[str],
        *,
        conversation_id: str | None = None,
        title: str | None = None,
        timeout: int | None = None,
    ) -> CLIResult:
        args = ["chat", "--json", "--kb", ",".join(kb_ids), "--trace", "full"]
        if conversation_id:
            args += ["--conversation", conversation_id]
        if title:
            args += ["--title", title]
        args.append(question)
        return self.run(args, timeout=timeout)

    def conversations_list(self, limit: int = 100) -> CLIResult:
        return self.run(["conversations", "list", "--limit", str(limit), "--json"])

    def conversations_delete(self, conversation_id: str) -> CLIResult:
        return self.run(["conversations", "delete", conversation_id, "--json"])

    def conversations_show(self, conversation_id: str) -> CLIResult:
        return self.run(["conversations", "show", conversation_id, "--json"])

    def traces_show(self, conversation_id: str, message_id: str) -> CLIResult:
        return self.run(["traces", "show", conversation_id, message_id, "--json"])

    # ------------------------------------------------------------ 向量诊断

    def vector_audit(self) -> CLIResult:
        return self.run(["vector", "audit", "--json"])

    def vector_count(self, kb_id: str) -> CLIResult:
        return self.run(["vector", "count", "--kb", kb_id, "--json"])

    def vector_get(self, chunk_id: str) -> CLIResult:
        return self.run(["vector", "get", chunk_id, "--json"])
