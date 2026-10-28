"""D07 证据导出与规范化：把 CLI 原始结果整理成可离线评分的证据链。

只做整理与索引，不补缺失记录：
- 原文标准证据（源文档段落、locator、hash）
- 解析/切块映射（chunk_id -> 全文、锚点）
- 每次检索各阶段候选（dense/bm25/rrf/rerank）与实际可见上下文
- 完整回答、引用原文与定位、引用标记位置
"""

from __future__ import annotations

import re
from typing import Any

from .core import RunContext, atomic_write_json, utc_iso, write_jsonl
from .corpus_spec import DOCUMENTS
from .facts import FACTS, VERSION_POLICY, Fact, version_policy_for
from .render import normalize

CITATION_MARKER_RE = re.compile(r"\[(\d+)\]")


def codepoint_spans(text: str, pattern: re.Pattern[str]) -> list[dict[str, Any]]:
    return [
        {"marker": match.group(0), "index": int(match.group(1)), "span": [match.start(), match.end()]}
        for match in pattern.finditer(text)
    ]


def source_segments() -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for spec in DOCUMENTS:
        for index, block in enumerate(spec.blocks):
            kind = block.get("type")
            if kind == "heading":
                text = str(block.get("text", ""))
            elif kind == "paragraph":
                text = str(block.get("text", ""))
            elif kind == "table":
                text = " ".join(str(c) for c in block.get("header", [])) + " " + " ".join(
                    " ".join(str(c) for c in row) for row in block.get("rows", []))
            else:
                continue
            segments.append({
                "evidence_ref": f"{spec.document_ref}#block-{index}",
                "document_ref": spec.document_ref,
                "revision": spec.revision,
                "text": text,
                "locator": {"block_index": index, "block_type": kind},
            })
    return segments


def standard_facts_payload(fact_ids: list[str] | None = None) -> list[dict[str, Any]]:
    selected = [f for f in FACTS if fact_ids is None or f.fact_id in fact_ids]
    return [fact.as_dict() for fact in selected]


def build_chunk_map(collected: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    chunk_map: dict[str, dict[str, Any]] = {}
    for entry in collected:
        for chunk in entry.get("chunks") or []:
            chunk_id = str(chunk.get("chunk_id") or "")
            if not chunk_id:
                continue
            chunk_map[chunk_id] = {
                "chunk_id": chunk_id,
                "document_ref": entry["document_ref"],
                "doc_id": entry.get("doc_id"),
                "content": chunk.get("content") or "",
                "chunk_index": chunk.get("chunk_index"),
                "heading_path": chunk.get("heading_path") or [],
                "page_start": chunk.get("page_start"),
                "page_end": chunk.get("page_end"),
                "source_type": chunk.get("source_type"),
            }
    return chunk_map


def stage_candidates(
    retrieval_traces: list[dict[str, Any]], chunk_map: dict[str, dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    stages: dict[str, list[dict[str, Any]]] = {}
    for trace in retrieval_traces:
        source = str(trace.get("source") or "unknown")
        chunk_id = str(trace.get("chunk_id") or "")
        resolved = chunk_map.get(chunk_id)
        stages.setdefault(source, []).append({
            "candidate_ref": f"{source}:{chunk_id}",
            "chunk_id": chunk_id,
            "rank": trace.get("rank"),
            "score": trace.get("score"),
            "doc_id": trace.get("doc_id"),
            "document_ref": resolved.get("document_ref") if resolved else None,
            "content_status": "full" if resolved else "missing",
            "text": resolved.get("content") if resolved else (trace.get("content_preview") or ""),
            "content_preview": trace.get("content_preview") or "",
        })
    for source in stages:
        stages[source].sort(key=lambda item: (item.get("rank") is None, item.get("rank") or 0))
    return stages


def visible_context(
    accepted_chunk_ids: list[str], chunk_map: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    segments: list[dict[str, Any]] = []
    missing: list[str] = []
    for chunk_id in accepted_chunk_ids:
        resolved = chunk_map.get(chunk_id)
        if resolved is None:
            missing.append(chunk_id)
            continue
        segments.append({
            "evidence_ref": f"chunk:{chunk_id}",
            "chunk_id": chunk_id,
            "document_ref": resolved["document_ref"],
            "text": resolved["content"],
        })
    status = "missing" if not segments else ("partial" if missing else "complete")
    return {
        "context_ref": "visible:accepted-chunks",
        "export_status": status,
        "content_kind": "full",
        "segments": segments,
        "missing_parts": missing,
        "note": "实际可见上下文取 Agent 步骤中 accepted_chunk_ids 对应的完整切块全文。",
    }


def normalize_case(
    trial: dict[str, Any],
    case: Any,
    chunk_map: dict[str, dict[str, Any]],
    fact_ids: list[str],
) -> dict[str, Any]:
    turns_payload: list[dict[str, Any]] = []
    for turn in trial.get("turns") or []:
        answer = turn.get("answer") or ""
        citations: list[dict[str, Any]] = []
        for citation in turn.get("citations") or []:
            quote = citation.get("quote") or ""
            anchor = citation.get("anchor") or {}
            chunk_id = citation.get("chunk_id")
            resolved = chunk_map.get(str(chunk_id)) if chunk_id else None
            source_text = resolved["content"] if resolved else ""
            if quote and source_text and quote in source_text:
                quote_match = "exact"
            elif quote and source_text and normalize(quote) and normalize(quote) in normalize(source_text):
                quote_match = "normalized"
            else:
                quote_match = "none"
            citations.append({
                "citation_ref": f"cite:{citation.get('citation_id') or citation.get('index')}",
                "citation_id": citation.get("citation_id"),
                "index": citation.get("index"),
                "document_ref": resolved.get("document_ref") if resolved else None,
                "doc_id": citation.get("doc_id"),
                "doc_title": citation.get("doc_title"),
                "chunk_id": chunk_id,
                "quote": quote,
                "quote_match": quote_match,
                "quote_in_source": quote_match != "none",
                "locator": anchor,
                "page_range": citation.get("page_range") or [],
                "source_status": citation.get("source_status"),
                "source_evidence_ref": f"chunk:{chunk_id}" if chunk_id else None,
                "source_text": resolved.get("content") if resolved else "",
            })
        turns_payload.append({
            "turn_index": turn.get("turn_index"),
            "user_message": turn.get("user_message"),
            "answer": answer,
            "answer_status": turn.get("answer_status"),
            "conversation_id": turn.get("conversation_id"),
            "assistant_message_id": turn.get("assistant_message_id"),
            "returncode": turn.get("returncode"),
            "ok": turn.get("ok"),
            "error": turn.get("error"),
            "citation_markers": codepoint_spans(answer, CITATION_MARKER_RE),
            "citations": citations,
            "retrieval_stages": stage_candidates(turn.get("retrieval_traces") or [], chunk_map),
            "visible_context": visible_context(turn.get("accepted_chunk_ids") or [], chunk_map),
            "query_trace": turn.get("query_trace") or {},
            "usage": turn.get("usage") or {},
            "timing": turn.get("timing") or {},
            "raw_path": turn.get("raw_path"),
        })
    return {
        "case_id": case.case_id,
        "base_case_id": case.base_case_id,
        "scenario": case.scenario,
        "difficulty": case.difficulty,
        "answerability": case.answerability,
        "expected_behavior": case.expected_behavior,
        "split": case.split,
        "dimensions": list(case.dimensions),
        "target_kb": case.target_kb,
        "question": case.question,
        "conversation_script": list(case.conversation_script),
        "required_fact_ids": list(case.required_fact_ids),
        "optional_fact_ids": list(case.optional_fact_ids),
        "forbidden_claims": list(case.forbidden_claims),
        "document_families": list(case.document_families),
        "standard_facts": standard_facts_payload(fact_ids if fact_ids else None),
        "version_policy": version_policy_for(case.document_families),
        "conversation_id": trial.get("conversation_id"),
        "kb_ids": trial.get("kb_ids") or [],
        "trial_index": trial.get("trial_index"),
        "turns": turns_payload,
    }


def export_evidence(
    ctx: RunContext,
    trials: list[dict[str, Any]],
    cases: list[Any],
    collected: list[dict[str, Any]],
) -> dict[str, Any]:
    chunk_map = build_chunk_map(collected)
    segments = source_segments()
    case_by_id = {case.case_id: case for case in cases}
    normalized: list[dict[str, Any]] = []
    for trial in trials:
        case = case_by_id[trial["case_id"]]
        fact_ids = sorted(set(trial.get("required_fact_ids") or []))
        normalized.append(normalize_case(trial, case, chunk_map, fact_ids))
    registry = {
        "chunk_count": len(chunk_map),
        "chunk_ids": sorted(chunk_map),
        "source_segment_count": len(segments),
        "source_segments": segments,
        "standard_facts": standard_facts_payload(None),
        "version_policy": VERSION_POLICY,
        "cases": len(normalized),
        "exported_at": utc_iso(),
        "checks": {
            "chunk_full_text": "complete" if chunk_map else "missing",
            "retrieval_stage_export": "complete",
            "visible_context_basis": "accepted_chunk_ids",
        },
    }
    atomic_write_json(ctx.path("export", "evidence-registry.json"), registry)
    atomic_write_json(ctx.path("export", "chunks.json"), chunk_map)
    atomic_write_json(ctx.path("export", "source-segments.json"), segments)
    write_jsonl(ctx.path("normalized", "cases.jsonl"), normalized)
    return {"registry": registry, "cases": normalized}
