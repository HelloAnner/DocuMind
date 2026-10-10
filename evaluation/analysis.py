"""D10 统计分析与评分：程序算所有分母，不做加权总分蒙混。

主指标：整体准确性（端到端任务正确率）= P/N。
每题唯一总体状态 P/F/U/E：E 系统故障无结果；F 明确关键失败；
U 证据/标准/裁判未决；P 全部必要检查通过。不适用维度不进分母。
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from .core import RunContext, atomic_write_json, utc_iso, write_jsonl


def _dimension_judgments(record: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        dimension: judgment
        for dimension, judgment in (record.get("dimensions") or {}).items()
        if isinstance(judgment, dict) and judgment.get("checks") and dimension != "faithfulness_by_turn"
    }


def case_outcome(record: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
    turns = case.get("turns") or []
    expected_permission = case.get("expected_behavior") == "deny_permission"
    cli_failed = any(not turn.get("ok") for turn in turns)
    if cli_failed and not expected_permission:
        return {"status": "E", "reason": "CLI 调用失败，任务无结果", "failed_dimensions": [],
                "unknown_dimensions": [], "passed_dimensions": []}
    judgments = _dimension_judgments(record)
    failed, unknown, passed = [], [], []
    for dimension, judgment in judgments.items():
        verdict = judgment.get("verdict")
        if verdict == "fail":
            failed.append(dimension)
        elif verdict == "unknown":
            unknown.append(dimension)
        elif verdict == "pass":
            passed.append(dimension)
    judge_errors = [dimension for dimension, judgment in judgments.items() if judgment.get("judge_error")]
    if failed:
        status, reason = "F", "关键维度失败: " + ",".join(sorted(failed))
    elif unknown or judge_errors:
        status, reason = "U", "未决维度: " + ",".join(sorted(set(unknown + judge_errors)))
    elif passed:
        status, reason = "P", "全部必要维度通过"
    else:
        status, reason = "U", "无可判断维度"
    return {"status": status, "reason": reason, "failed_dimensions": sorted(failed),
            "unknown_dimensions": sorted(unknown), "passed_dimensions": sorted(passed)}


def wilson(passed: int, total: int, z: float = 1.96) -> list[float] | None:
    if total <= 0:
        return None
    phat = passed / total
    denominator = 1 + z * z / total
    center = (phat + z * z / (2 * total)) / denominator
    half = z * ((phat * (1 - phat) / total + z * z / (4 * total * total)) ** 0.5) / denominator
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def analyze(
    ctx: RunContext, cases: list[dict[str, Any]], verdicts: list[dict[str, Any]],
    *, ingestion: dict[str, Any], execution_totals: dict[str, Any],
    planned_cases: int, cleanup: dict[str, Any] | None = None,
) -> dict[str, Any]:
    verdict_by_id = {record["case_id"]: record for record in verdicts}
    case_by_id = {case["case_id"]: case for case in cases}

    outcomes: list[dict[str, Any]] = []
    for case in cases:
        record = verdict_by_id.get(case["case_id"]) or {"case_id": case["case_id"], "dimensions": {}}
        outcome = case_outcome(record, case)
        outcomes.append({
            "case_id": case["case_id"], "base_case_id": case["base_case_id"],
            "scenario": case["scenario"], "difficulty": case["difficulty"],
            "answerability": case["answerability"], "expected_behavior": case["expected_behavior"],
            "split": case["split"],
            "document_families": case.get("document_families") or [],
            "required_fact_ids": case.get("required_fact_ids") or [],
            **outcome,
        })

    counts = Counter(row["status"] for row in outcomes)
    passed, failed, unknown, errors = counts["P"], counts["F"], counts["U"], counts["E"]
    total = len(outcomes)
    overall = {
        "metric_id": "overall_accuracy",
        "title": "整体准确性（端到端任务正确率）",
        "P": passed, "F": failed, "U": unknown, "E": errors, "N": total,
        "planned_tasks": planned_cases,
        "processed_tasks": total,
        "pending_tasks": max(planned_cases - total, 0),
        "execution_coverage": ratio(total, planned_cases),
        "value": ratio(passed, total),
        "conservative_value": ratio(passed, total),
        "decided_value": ratio(passed, passed + failed),
        "decision_coverage": ratio(passed + failed, total),
        "unknown_rate": ratio(unknown, total),
        "system_error_rate": ratio(errors, total),
        "confidence_interval": wilson(passed, total),
        "interval_method": "Wilson score interval",
        "interval_confidence": 0.95,
        "statistical_unit": "case（首次 trial，一次多轮会话记为一个任务）",
        "basis": "rule_verified+judge_estimate",
        "note": "P/N 为首次 trial 结果；多轮违规/重试恢复另列。未校准指标只作为自动估计。",
    }

    def slice_by(key: str) -> list[dict[str, Any]]:
        buckets: dict[str, list[dict[str, Any]]] = {}
        for row in outcomes:
            value = row.get(key)
            if isinstance(value, list):
                value = ",".join(sorted(value)) if value else "(none)"
            buckets.setdefault(str(value), []).append(row)
        result: list[dict[str, Any]] = []
        for value, rows in sorted(buckets.items()):
            sub = Counter(row["status"] for row in rows)
            n = len(rows)
            result.append({
                "value": value, "n": n, "P": sub["P"], "F": sub["F"], "U": sub["U"], "E": sub["E"],
                "accuracy": ratio(sub["P"], n), "confidence_interval": wilson(sub["P"], n),
            })
        return result

    # ---------------------------------------------------------- 阶段指标
    fact_total = len(ingestion.get("per_fact") or [])
    fact_retained = sum(1 for row in ingestion.get("per_fact") or [] if row["retention"] == "retained")
    fact_missing = sum(1 for row in ingestion.get("per_fact") or [] if row["retention"] == "missing")
    fact_unknown = sum(1 for row in ingestion.get("per_fact") or [] if row["retention"] == "unknown")

    retrieval_stages: dict[str, dict[str, Any]] = {}
    for record in verdicts:
        retrieval = ((record.get("dimensions") or {}).get("rule", {}) or {}).get("retrieval", {})
        top_required = retrieval.get("required") or 0
        for stage, payload in (retrieval.get("stages") or {}).items():
            entry = retrieval_stages.setdefault(
                stage, {"cases": 0, "hits": 0, "single_hits": 0, "required": 0})
            entry["cases"] += 1
            entry["hits"] += payload.get("hits") or 0
            entry["single_hits"] += payload.get("single_hits") or 0
            entry["required"] += payload.get("required") or top_required
    for stage, entry in retrieval_stages.items():
        entry["recall"] = ratio(entry["hits"], entry["required"])
        entry["single_recall"] = ratio(entry["single_hits"], entry["required"])

    citation_rule_rows: list[dict[str, Any]] = []
    for record in verdicts:
        rule = ((record.get("dimensions") or {}).get("rule") or {})
        citation_rule_rows.extend(rule.get("citations") or [])
    quote_ok = sum(1 for row in citation_rule_rows if row.get("quote_in_source"))
    location_ok = sum(1 for row in citation_rule_rows if row.get("location_status") == "exact")

    judge_metrics: dict[str, dict[str, Any]] = {}
    for dimension in ("fact_correctness", "completeness", "faithfulness", "citation", "behavior", "dialogue", "relevance"):
        checks_total = 0
        checks_pass, checks_fail, checks_unknown = 0, 0, 0
        case_pass, case_fail, case_unknown, case_na = 0, 0, 0, 0
        for record in verdicts:
            judgment = (record.get("dimensions") or {}).get(dimension)
            if not isinstance(judgment, dict) or not judgment.get("checks"):
                continue
            for check in judgment["checks"]:
                checks_total += 1
                status = check.get("status")
                if status == "pass":
                    checks_pass += 1
                elif status == "fail":
                    checks_fail += 1
                else:
                    checks_unknown += 1
            verdict = judgment.get("verdict")
            if verdict == "pass":
                case_pass += 1
            elif verdict == "fail":
                case_fail += 1
            elif verdict == "unknown":
                case_unknown += 1
            else:
                case_na += 1
        if checks_total == 0:
            continue
        judge_metrics[dimension] = {
            "metric_id": f"dimension_{dimension}",
            "cases": {"pass": case_pass, "fail": case_fail, "unknown": case_unknown, "not_applicable": case_na},
            "checks": {"total": checks_total, "pass": checks_pass, "fail": checks_fail, "unknown": checks_unknown},
            "pass_rate": ratio(case_pass, case_pass + case_fail + case_unknown),
            "check_pass_rate": ratio(checks_pass, checks_total),
            "basis": "judge_estimate",
        }

    metrics = {
        "generated_at": utc_iso(),
        "overall": overall,
        "slices": {
            "scenario": slice_by("scenario"),
            "difficulty": slice_by("difficulty"),
            "answerability": slice_by("answerability"),
            "document_family": slice_by("document_families"),
        },
        "ingestion": {
            "files_total": ingestion.get("files_total"),
            "files_indexed": ingestion.get("files_indexed"),
            "ingestion_rate": ingestion.get("ingestion_rate"),
            "facts_total": fact_total,
            "facts_retained": fact_retained,
            "facts_missing": fact_missing,
            "facts_unknown": fact_unknown,
            "fact_retention_rate": ratio(fact_retained, fact_total),
            "basis": "rule_verified",
        },
        "retrieval": {
            "stages": retrieval_stages,
            "basis": "rule_verified（必要条件词匹配，见限制）",
        },
        "citations": {
            "relations": len(citation_rule_rows),
            "quote_in_source": quote_ok,
            "quote_in_source_rate": ratio(quote_ok, len(citation_rule_rows)),
            "exact_location": location_ok,
            "location_rate": ratio(location_ok, len(citation_rule_rows)),
            "basis": "rule_verified",
        },
        "judges": judge_metrics,
        "execution": execution_totals,
        "cases": outcomes,
    }

    overall_payload = {
        "system": "DocuMind",
        "run_id": ctx.run_id,
        "overall_accuracy": overall,
        "dimension_summary": judge_metrics,
        "gate": {
            "cleanup_verified": bool(cleanup and cleanup.get("cleanup_status") == "verified"),
            "cleanup_status": (cleanup or {}).get("cleanup_status", "unknown"),
        },
        "computed_at": utc_iso(),
    }
    atomic_write_json(ctx.path("analysis", "metrics.json"), metrics)
    atomic_write_json(ctx.path("analysis", "overall.json"), overall_payload)
    write_jsonl(ctx.path("analysis", "outcomes.jsonl"), outcomes)

    failures = [row for row in outcomes if row["status"] in ("F", "U", "E")]
    write_jsonl(ctx.path("analysis", "failures.jsonl"), failures)

    findings = build_findings(metrics, outcomes, cleanup or {})
    atomic_write_json(ctx.path("analysis", "findings.json"), findings)
    return {"metrics": metrics, "overall": overall_payload, "findings": findings}


def build_findings(metrics: dict[str, Any], outcomes: list[dict[str, Any]], cleanup: dict[str, Any]) -> dict[str, Any]:
    overall = metrics["overall"]
    findings: list[dict[str, Any]] = []
    findings.append({
        "finding_id": "F-OVERALL", "section_id": "overall", "severity": "info",
        "approved_statement": (
            f"本次共 {overall['N']} 个冻结任务，整体准确性 P/N = {overall['P']}/{overall['N']}"
            f"（{overall['value']}），F={overall['F']}、U={overall['U']}、E={overall['E']}。"
        ),
        "metric_ids": ["overall_accuracy"], "evidence_refs": ["analysis/overall.json"],
        "approved_recommendation": None, "root_cause_status": "confirmed",
    })
    worst = sorted(
        [row for row in outcomes if row["status"] in ("F", "U")],
        key=lambda row: row["case_id"],
    )
    for row in worst[:10]:
        findings.append({
            "finding_id": f"F-{row['case_id']}", "section_id": "cases", "severity": "major",
            "approved_statement": (
                f"{row['case_id']}（{row['scenario']}/{row['difficulty']}）判定为 {row['status']}："
                f"{row['reason']}。"
            ),
            "metric_ids": [], "evidence_refs": [f"normalized/cases.jsonl#{row['case_id']}"],
            "approved_recommendation": None, "root_cause_status": "confirmed",
        })
    gate = "verified" if cleanup.get("cleanup_status") == "verified" else cleanup.get("cleanup_status", "unknown")
    findings.append({
        "finding_id": "F-CLEANUP", "section_id": "gates",
        "severity": "info" if gate == "verified" else "critical",
        "approved_statement": f"清理核验状态：{gate}；残留项 {len(cleanup.get('remaining') or {})} 张表非零。",
        "metric_ids": [], "evidence_refs": ["cleanup.json", "verification/after.json"],
        "approved_recommendation": None, "root_cause_status": "confirmed",
    })
    return {
        "run_ref": metrics.get("run_ref"),
        "findings": findings,
        "limitations": [
            {"limitation_id": "L-ISOLATION", "text": "隔离为同一部署内的独立租户命名空间，不是独立实例。",
             "evidence_refs": ["preparation/isolation.json"]},
            {"limitation_id": "L-CALIBRATION", "text": "裁判未经人工校准，指标属于自动估计，不等于生产真实准确率。",
             "evidence_refs": ["grading/judge-calls.jsonl"]},
            {"limitation_id": "L-RETRIEVAL", "text": "召回指标用必要条件词匹配近似，语义层由裁判单独判断。",
             "evidence_refs": ["analysis/metrics.json"]},
            {"limitation_id": "L-RETRIEVAL-STAGE",
             "text": "逐阶段候选按系统上报的 source 归类；一次回答可能包含多查询检索，程序不臆测未上报的归属，"
                     "因此某阶段召回低只代表该阶段被标记的候选本身没有覆盖必需事实。",
             "evidence_refs": ["export/evidence-registry.json"]},
            {"limitation_id": "L-CORPUS", "text": "语料为受控合成文档，分布不等于真实业务流量。",
             "evidence_refs": ["corpus/manifest.json"]},
        ],
        "computed_at": utc_iso(),
    }
