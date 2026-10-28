"""D06 真实 CLI 执行：每题独立会话，按真实 Agent 全链路采集证据。

- 单题一个会话；固定多轮在会话内延续，范围不扩大。
- 保存每轮完整回答、引用、逐阶段检索候选、Agent 步骤与 usage。
- 调用失败（超时/权限拒绝/业务错误）原样保留，不重试到通过，不改题。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .core import RunContext, atomic_write_json, utc_iso
from .dataset import Case
from .dmcli import CLIResult, DocuMindCLI


def _accepted_chunk_ids(agent_trace: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    for step in agent_trace.get("react_steps") or []:
        for chunk_id in step.get("accepted_chunk_ids") or []:
            if chunk_id not in ids:
                ids.append(chunk_id)
    for chunk_id in agent_trace.get("accepted_chunk_ids") or []:
        if chunk_id not in ids:
            ids.append(chunk_id)
    return ids


def normalize_turn(turn_index: int, user_message: str, result: CLIResult, raw_path: Path) -> dict[str, Any]:
    payload = result.json() or {}
    trace = payload.get("trace") or {}
    agent_trace = trace.get("agent_trace") or {}
    response = payload.get("response") or {}
    turn = {
        "turn_index": turn_index,
        "user_message": user_message,
        "returncode": result.returncode,
        "ok": result.ok,
        "duration_ms": result.duration_ms,
        "raw_path": str(raw_path),
        "conversation_id": (payload.get("request") or {}).get("conversation_id"),
        "answer": response.get("content") or "",
        "answer_status": response.get("status") or ("complete" if result.ok else "missing"),
        "assistant_message_id": response.get("assistant_message_id"),
        "user_message_id": response.get("user_message_id"),
        "citations": payload.get("citations") or [],
        "retrieval_traces": trace.get("retrieval_traces") or [],
        "accepted_chunk_ids": _accepted_chunk_ids(agent_trace),
        "agent_trace": agent_trace,
        "query_trace": trace.get("query_trace") or {},
        "usage": (payload.get("execution") or {}).get("usage") or {},
        "timing": payload.get("timing") or {},
        "identity": payload.get("identity") or {},
        "kb_ids": (payload.get("request") or {}).get("kb_ids") or [],
        "stderr": result.stderr[-2000:],
    }
    if not result.ok:
        turn["error"] = {
            "type": "cli_error",
            "returncode": result.returncode,
            "message": result.stderr.strip()[-500:] or result.stdout.strip()[-500:],
        }
    return turn


@dataclass
class Executor:
    ctx: RunContext
    cli: DocuMindCLI
    eval_kb_id: str
    foreign_kb_id: str | None = None
    per_call_timeout: int = 420
    totals: dict[str, Any] = field(default_factory=lambda: {"cases": 0, "turns": 0, "errors": 0})

    def _raw_dir(self, case_id: str, trial: int) -> Path:
        target = self.ctx.path("raw", case_id, f"trial-{trial}")
        target.mkdir(parents=True, exist_ok=True)
        return target

    def run_case(self, case: Case, trial: int = 1) -> dict[str, Any]:
        raw_dir = self._raw_dir(case.case_id, trial)
        turns: list[dict[str, Any]] = []
        script = case.conversation_script or [{"turn_index": 1, "user_message": case.question}]
        kb_ids = [self.eval_kb_id]
        if case.target_kb == "foreign" and self.foreign_kb_id:
            kb_ids = [self.foreign_kb_id]
        conversation_id: str | None = None
        started = utc_iso()
        for entry in script:
            index = int(entry.get("turn_index", len(turns) + 1))
            message = str(entry.get("user_message") or case.question)
            result = self.cli.chat(
                message, kb_ids, conversation_id=conversation_id,
                title=case.case_id if conversation_id is None else None,
                timeout=self.per_call_timeout,
            )
            raw_path = raw_dir / f"turn-{index:02d}.json"
            payload = result.json()
            atomic_write_json(raw_path.with_suffix(".meta.json"), {
                "argv": result.argv, "returncode": result.returncode,
                "duration_ms": result.duration_ms, "at": utc_iso(),
                "stdout_sha256_note": "stdout 全文见同名 .stdout.txt",
            })
            raw_path.with_suffix(".stdout.txt").write_text(result.stdout, encoding="utf-8")
            raw_path.with_suffix(".stderr.txt").write_text(result.stderr, encoding="utf-8")
            if payload is not None:
                atomic_write_json(raw_path, payload)
            turn = normalize_turn(index, message, result, raw_path)
            if conversation_id is None and turn.get("conversation_id"):
                conversation_id = turn["conversation_id"]
            turns.append(turn)
            self.totals["turns"] += 1
        self.totals["cases"] += 1
        errors = [turn for turn in turns if not turn.get("ok")]
        self.totals["errors"] += len(errors)
        record = {
            "case_id": case.case_id,
            "base_case_id": case.base_case_id,
            "scenario": case.scenario,
            "difficulty": case.difficulty,
            "answerability": case.answerability,
            "expected_behavior": case.expected_behavior,
            "split": case.split,
            "dimensions": list(case.dimensions),
            "target_kb": case.target_kb,
            "required_fact_ids": list(case.required_fact_ids),
            "optional_fact_ids": list(case.optional_fact_ids),
            "forbidden_claims": list(case.forbidden_claims),
            "conversation_id": conversation_id,
            "kb_ids": kb_ids,
            "trial_index": trial,
            "started_at": started,
            "finished_at": utc_iso(),
            "turns": turns,
            "system_error": bool(errors) if case.expected_behavior != "deny_permission" else False,
            "cli_error_turns": [turn["turn_index"] for turn in errors],
        }
        return record

    def run_all(self, cases: list[Case], trial: int = 1) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for case in cases:
            record = self.run_case(case, trial)
            records.append(record)
            self.ctx.append_jsonl("normalized/trials.jsonl", [record])
        atomic_write_json(self.ctx.path("execution/status.json"), {
            "totals": self.totals, "finished_at": utc_iso(),
        })
        return records
