"""D09 分支：独立盲审与争议定位对账。

样本由程序选择（先风险后随机），不看初判分数；盲审只在原证据下复核；
分歧项去身份后交对账；仍不确定保留 unknown 并转人工。程序冻结盲审 hash，
对账阶段不得改动原证据。
"""

from __future__ import annotations

import random
from typing import Any

from .core import RunContext, atomic_write_json, sha256_json, utc_iso, write_jsonl
from .grading import VERDICT_ORDER, aggregate
from .prompts import build

REVIEW_REASON_CODES = {
    "review_supported", "review_contradicted", "review_required_omitted", "review_forbidden",
    "review_evidence_gap", "review_standard_gap", "review_policy_gap", "review_rule_result",
    "no_checks", "not_applicable",
}
ADJUDICATION_REASON_CODES = {
    "evidence_supported", "evidence_contradicted", "required_omission", "semantic_equivalence",
    "scope_mismatch", "policy_gap", "evidence_gap", "input_mismatch", "rule_result", "not_applicable",
}


def select_review_targets(
    verdicts: list[dict[str, Any]], *, limit: int, seed: int,
) -> list[dict[str, Any]]:
    """风险优先（fail/unknown），其余随机补齐；抽样规则由程序固定。"""
    risky: list[dict[str, Any]] = []
    others: list[dict[str, Any]] = []
    for record in verdicts:
        for dimension, judgment in (record.get("dimensions") or {}).items():
            if dimension in ("claims", "rule", "faithfulness_by_turn"):
                continue
            if not isinstance(judgment, dict) or not judgment.get("checks"):
                continue
            item = {"case_id": record["case_id"], "dimension": dimension, "verdict": judgment.get("verdict")}
            (risky if judgment.get("verdict") in ("fail", "unknown") else others).append(item)
    random.Random(seed).shuffle(others)
    random.Random(seed + 1).shuffle(risky)
    return (risky + others)[:limit]


def blind_review(
    ctx: RunContext, router: Any, verdicts: list[dict[str, Any]],
    payloads: dict[str, dict[str, Any]], *, limit: int, seed: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    targets = select_review_targets(verdicts, limit=limit, seed=seed)
    rows: list[dict[str, Any]] = []
    for target in targets:
        key = f"{target['case_id']}:{target['dimension']}"
        payload = payloads.get(key)
        if payload is None:
            continue
        role_payload = {
            "original_dimension": target["dimension"],
            "role_payload": {k: v for k, v in payload.items() if k != "applicable"},
            "applicable": True,
            "checks_spec": payload.get("checks_spec") or [],
            "severity_rules": payload.get("severity_rules") or {},
            "default_severity": payload.get("default_severity", "minor"),
            "role_evidence_basis": "raw_source",
            "failed_fact_id_pool": [],
        }
        system, user, hashes = build("review_blind", role_payload)
        call = router.call("review_blind", system, user, phase=f"blind:{key}")
        data = call.payload or {}
        checks = [
            {"check_id": check.get("check_id"), "target_id": check.get("target_id"),
             "required": True,
             "status": check.get("status") if check.get("status") in VERDICT_ORDER else "unknown",
             "reason_code": check.get("reason_code") if check.get("reason_code") in REVIEW_REASON_CODES else "review_evidence_gap",
             "reason": (check.get("reason") or "")[:400],
             "evidence_refs": check.get("evidence_refs") or []}
            for check in (data.get("checks") or [])
        ]
        required_specs = payload.get("checks_spec") or []
        by_id = {check["check_id"]: check for check in checks}
        for spec in required_specs:
            if spec["check_id"] not in by_id:
                checks.append({
                    "check_id": spec["check_id"], "target_id": spec["target_id"], "required": True,
                    "status": "unknown", "reason_code": "review_evidence_gap",
                    "reason": "盲审未返回该检查项", "evidence_refs": [],
                })
        judgment = aggregate(target["dimension"], checks)
        frozen = {"review_sha256": sha256_json(judgment), "frozen_at": utc_iso()}
        rows.append({
            "case_id": target["case_id"], "dimension": target["dimension"],
            "judgment": judgment, "freeze": frozen, "prompt_hashes": hashes,
            "model": call.model, "error": call.error, "sample_type": "risk" if target["verdict"] in ("fail", "unknown") else "random",
        })
    write_jsonl(ctx.path("grading", "review-blind.jsonl"), rows)
    return rows, {"targets": len(targets), "reviewed": len(rows)}


def find_disputes(
    verdicts: list[dict[str, Any]], blind_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    initial: dict[str, dict[str, Any]] = {}
    for record in verdicts:
        for dimension, judgment in (record.get("dimensions") or {}).items():
            if isinstance(judgment, dict) and judgment.get("checks"):
                initial[f"{record['case_id']}:{dimension}"] = judgment
    disputes: list[dict[str, Any]] = []
    for row in blind_rows:
        key = f"{row['case_id']}:{row['dimension']}"
        original = initial.get(key)
        if original is None:
            continue
        if original.get("verdict") == row["judgment"].get("verdict"):
            continue
        origin_checks = {check["check_id"]: check for check in original.get("checks") or []}
        blind_checks = {check["check_id"]: check for check in row["judgment"].get("checks") or []}
        for check_id, blind_check in blind_checks.items():
            origin_check = origin_checks.get(check_id)
            if origin_check is None or origin_check.get("status") == blind_check.get("status"):
                continue
            disputes.append({
                "case_id": row["case_id"], "dimension": row["dimension"], "check_id": check_id,
                "assessment_a": {"status": origin_check.get("status"),
                                 "evidence_refs": origin_check.get("evidence_refs") or [],
                                 "reason": origin_check.get("reason") or ""},
                "assessment_b": {"status": blind_check.get("status"),
                                 "evidence_refs": blind_check.get("evidence_refs") or [],
                                 "reason": blind_check.get("reason") or ""},
                "freeze_ref": row["freeze"]["review_sha256"],
            })
    return disputes
