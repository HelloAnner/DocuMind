"""D04 入库与解析核验：经 CLI 建库、上传、等待、导出解析/切块/锚点。

程序核验为主：文件状态、切块数量、标准事实的必要条件词是否真的出现在
解析产物里；跨多个 chunk 保留也允许。语义判定留到 D09 离线进行。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .core import RunContext, atomic_write_json, utc_iso
from .dmcli import CLIResult, DocuMindCLI
from .facts import FACTS
from .render import normalize

KB_NAME = "DocuMind Eval KB"
KB_DESCRIPTION = "隔离准确性评估专用知识库（run 结束后销毁）"


@dataclass
class Ingestor:
    ctx: RunContext
    cli: DocuMindCLI
    upload_timeout: int = 300
    kb_id: str | None = None
    kb_result: dict[str, Any] | None = None
    calls: list[dict[str, Any]] = field(default_factory=list)

    def _record(self, name: str, result: CLIResult, extra: dict[str, Any] | None = None) -> None:
        row = {"step": name, "returncode": result.returncode, "ok": result.ok,
               "duration_ms": result.duration_ms, "at": utc_iso()}
        if extra:
            row.update(extra)
        if not result.ok:
            row["stderr"] = result.stderr[-500:]
        self.calls.append(row)

    def create_kb(self) -> str:
        result = self.cli.kb_create(KB_NAME, KB_DESCRIPTION)
        self._record("kb_create", result)
        if not result.ok:
            raise RuntimeError(f"建库失败: {result.stderr[:400]}")
        payload = result.json() or {}
        kb_id = str(payload.get("id") or (payload.get("knowledge_base") or {}).get("id") or "")
        if not kb_id:
            raise RuntimeError(f"建库返回缺少 id: {result.stdout[:300]}")
        self.kb_id = kb_id
        self.kb_result = payload
        return kb_id

    def upload(self, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
        assert self.kb_id, "必须先建库"
        uploaded: list[dict[str, Any]] = []
        for record in files:
            path = Path(record["file_path"])
            result = self.cli.documents_upload(path, self.kb_id, self.upload_timeout)
            self._record("documents_upload", result, {"document_ref": record["document_ref"]})
            payload = result.json() or {}
            document = payload.get("document") or payload.get("results", [{}])[0].get("document") or {}
            doc_id = str(document.get("doc_id") or payload.get("doc_id") or "")
            entry = {
                "document_ref": record["document_ref"],
                "document_family": record["document_family"],
                "revision": record["revision"],
                "file_name": record["file_name"],
                "file_type": record["file_type"],
                "file_sha256": record["file_sha256"],
                "file_path": record["file_path"],
                "upload_ok": result.ok,
                "doc_id": doc_id,
                "parse_status": document.get("parse_status"),
                "quality_score": document.get("quality_score"),
                "chunk_count": document.get("chunk_count"),
                "table_count": document.get("table_count"),
                "page_count": document.get("page_count"),
                "upload_stderr": result.stderr[-300:] if not result.ok else "",
                "uploaded_at": utc_iso(),
            }
            uploaded.append(entry)
        return uploaded

    def collect_documents(self, uploaded: list[dict[str, Any]]) -> list[dict[str, Any]]:
        collected: list[dict[str, Any]] = []
        for entry in uploaded:
            doc_id = entry.get("doc_id")
            if not doc_id:
                entry["collect_status"] = "no_document_id"
                collected.append(entry)
                continue
            show = self.cli.documents_show(doc_id)
            self._record("documents_show", show, {"document_ref": entry["document_ref"]})
            chunks = self.cli.documents_chunks(doc_id)
            self._record("documents_chunks", chunks, {"document_ref": entry["document_ref"]})
            blocks = self.cli.documents_blocks(doc_id)
            self._record("documents_blocks", blocks, {"document_ref": entry["document_ref"]})
            tables = self.cli.documents_tables(doc_id)
            self._record("documents_tables", tables, {"document_ref": entry["document_ref"]})
            show_payload = show.json() if isinstance(show.json(), dict) else {}
            entry["show"] = show_payload
            entry["chunks"] = _as_list(chunks.json()) or _as_list(show_payload.get("chunks"))
            entry["blocks"] = _as_list(blocks.json()) or _as_list(show_payload.get("blocks"))
            entry["tables"] = _as_list(tables.json()) or _as_list(show_payload.get("tables"))
            entry["cleaned_blocks"] = _as_list(show_payload.get("cleaned_blocks"))
            entry["collect_status"] = "ok" if (show.ok and chunks.ok) else "partial"
            target = self.ctx.path("preparation", "documents", entry["document_ref"])
            target.mkdir(parents=True, exist_ok=True)
            atomic_write_json(target / "chunks.json", entry["chunks"])
            atomic_write_json(target / "blocks.json", entry["blocks"])
            atomic_write_json(target / "tables.json", entry["tables"])
            if entry["show"] is not None:
                atomic_write_json(target / "show.json", entry["show"])
            collected.append(entry)
        return collected

    def verify_fact_retention(self, collected: list[dict[str, Any]]) -> dict[str, Any]:
        text_by_doc: dict[str, str] = {}
        for entry in collected:
            parts: list[str] = []
            for chunk in entry.get("chunks") or []:
                parts.append(str(chunk.get("content") or ""))
            for block in entry.get("blocks") or []:
                if isinstance(block, dict):
                    parts.append(str(block.get("text") or ""))
            for table in entry.get("tables") or []:
                parts.append(json_dumps(table))
            text_by_doc[entry["document_ref"]] = normalize("\n".join(parts))

        per_fact: list[dict[str, Any]] = []
        retained = 0
        for fact in FACTS:
            haystack = text_by_doc.get(fact.document_ref, "")
            missing = [term for term in fact.required_terms if normalize(term) not in haystack]
            ok = not missing and bool(haystack)
            retained += 1 if ok else 0
            per_fact.append({
                "fact_id": fact.fact_id,
                "document_ref": fact.document_ref,
                "retention": "retained" if ok else ("unknown" if not haystack else "missing"),
                "missing_terms": missing,
                "required_terms": len(fact.required_terms),
            })
        report = {
            "facts_total": len(FACTS),
            "facts_retained": retained,
            "retention_rate": round(retained / len(FACTS), 4) if FACTS else None,
            "per_fact": per_fact,
            "computed_at": utc_iso(),
        }
        atomic_write_json(self.ctx.path("preparation", "fact-map.jsonl").with_suffix(".json"), {
            "per_fact": per_fact,
        })
        return report

    def status(self) -> dict[str, Any]:
        return {"kb_id": self.kb_id, "calls": self.calls, "finished_at": utc_iso()}


def json_dumps(value: Any) -> str:
    import json
    return json.dumps(value, ensure_ascii=False)


def _as_list(value: Any) -> list[Any]:
    """CLI 有时返回单对象、有时返回列表；统一成列表，空值返回 []。"""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("items", "chunks", "blocks", "tables", "cleaned_blocks", "results"):
            nested = value.get(key)
            if isinstance(nested, list):
                return nested
        return [value]
    return []
