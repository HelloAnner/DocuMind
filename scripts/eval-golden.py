#!/usr/bin/env python3
import argparse
import json
import mimetypes
import os
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path


BASE_URL = os.environ.get("BASE_URL", "http://123.57.255.204:8089").rstrip("/")
LOGIN_EMAIL = os.environ.get("LOGIN_EMAIL", "Anner")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "1")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "180"))
DEFAULT_GOLDEN = Path("tests/golden/documind_core.json")


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def fail(message, detail=None):
    print(f"FAIL: {message}")
    if detail is not None:
        print(json.dumps(detail, ensure_ascii=False, indent=2))
    raise SystemExit(1)


def http_json(method, path, payload=None, token=None, timeout=60):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"{BASE_URL}{path}", data=data, headers=headers, method=method
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else None


def sse_post(path, payload, token):
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Accept": "text/event-stream",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    events = []
    current_event = None
    data_lines = []
    with urllib.request.urlopen(req, timeout=240) as resp:
        for raw_line in resp:
            line = raw_line.decode("utf-8").rstrip("\n")
            if not line:
                if current_event:
                    data_text = "\n".join(data_lines)
                    data = json.loads(data_text) if data_text else {}
                    events.append({"event": current_event, "data": data})
                    if current_event in {"answer.completed", "answer.failed"}:
                        break
                current_event = None
                data_lines = []
                continue
            if line.startswith("event:"):
                current_event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].strip())
    return events


def answer_text(events):
    return "".join(
        event["data"].get("text", "")
        for event in events
        if event["event"] == "answer.delta"
    )


def citations_from_events(events):
    citations = []
    for event in events:
        if event["event"] != "citation.delta":
            continue
        citation = event["data"].get("citation")
        if citation:
            citations.append(citation)
    return citations


def normalize(text):
    return " ".join(str(text).lower().split())


def xml_escape(text):
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def write_docx(path, paragraphs):
    document_body = "".join(
        f"<w:p><w:r><w:t>{xml_escape(paragraph)}</w:t></w:r></w:p>"
        for paragraph in paragraphs
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""",
        )
        zf.writestr(
            "_rels/.rels",
            """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""",
        )
        zf.writestr(
            "word/document.xml",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>{document_body}<w:sectPr/></w:body>
</w:document>""",
        )


def write_pdf(path, paragraphs):
    text = " ".join(paragraphs)
    safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 11 Tf 72 720 Td ({safe}) Tj ET".encode("utf-8")
    objects = [
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
        b"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
        f"5 0 obj\n<< /Length {len(stream)} >>\nstream\n".encode()
        + stream
        + b"\nendstream\nendobj\n",
    ]
    content = b"%PDF-1.4\n"
    offsets = [0]
    for obj in objects:
        offsets.append(len(content))
        content += obj
    xref = len(content)
    content += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
    for offset in offsets[1:]:
        content += f"{offset:010d} 00000 n \n".encode()
    content += (
        f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    path.write_bytes(content)


def write_pptx(path, slides):
    slide_overrides = "\n".join(
        f'  <Override PartName="/ppt/slides/slide{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for index in range(1, len(slides) + 1)
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
{slide_overrides}
</Types>""",
        )
        zf.writestr(
            "_rels/.rels",
            """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>""",
        )
        zf.writestr(
            "ppt/presentation.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst/>
</p:presentation>""",
        )
        for index, lines in enumerate(slides, start=1):
            paragraphs = "".join(
                f"<a:p><a:r><a:t>{xml_escape(line)}</a:t></a:r></a:p>"
                for line in lines
            )
            zf.writestr(
                f"ppt/slides/slide{index}.xml",
                f"""<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>{paragraphs}</p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>""",
            )


def mark_text(value, run_marker):
    return value.replace("DocuMind Golden", f"DocuMind Golden {run_marker}")


def marked_file_name(file_name, run_marker):
    path = Path(file_name)
    safe_marker = run_marker.replace("/", "-").replace("\\", "-")
    return f"{path.stem}-{safe_marker}{path.suffix}"


def materialize_document(tmpdir, doc, run_marker):
    path = Path(tmpdir) / marked_file_name(doc["file_name"], run_marker)
    fmt = doc["format"]
    if fmt == "docx":
        write_docx(path, [mark_text(text, run_marker) for text in doc["paragraphs"]])
    elif fmt == "pdf":
        write_pdf(path, [mark_text(text, run_marker) for text in doc["paragraphs"]])
    elif fmt == "pptx":
        write_pptx(
            path,
            [[mark_text(text, run_marker) for text in slide] for slide in doc["slides"]],
        )
    elif fmt in {"md", "txt"}:
        path.write_text(mark_text(doc["content"], run_marker), encoding="utf-8")
    else:
        raise ValueError(f"unsupported format: {fmt}")
    return path


def content_type_for(path):
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def multipart_upload(path, file_path, token):
    boundary = f"----documind{uuid.uuid4().hex}"
    content = file_path.read_bytes()
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            (
                f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'
                f"Content-Type: {content_type_for(file_path)}\r\n\r\n"
            ).encode(),
            content,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=body,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def poll_indexed(doc_id, token):
    deadline = time.time() + POLL_SECONDS
    last = None
    while time.time() < deadline:
        detail = http_json("GET", f"/api/admin/documents/{doc_id}", token=token)
        doc = detail.get("document") or {}
        status = doc.get("parse_status")
        if status != last:
            print(f"document {doc_id} status={status} chunks={doc.get('chunk_count')}")
            last = status
        if status == "indexed":
            return detail
        if status in {"parse_failed", "embedding_failed", "parse_low_confidence"}:
            fail(f"document {doc_id} failed to index", detail)
        time.sleep(3)
    fail(f"document {doc_id} did not become indexed within {POLL_SECONDS}s")


def run_case(token, kb_id, case, doc_id_map):
    question = case["question"]
    conv = http_json(
        "POST",
        "/api/conversations",
        {"title": f"Golden Eval {case['id']}", "kb_ids": [kb_id]},
        token=token,
    )
    conv_id = conv["conversation_id"]
    events = sse_post(
        f"/api/conversations/{conv_id}/messages",
        {
            "content": question,
            "kb_ids": [],
            "client_request_id": f"golden-{case['id']}-{uuid.uuid4()}",
            "stream": True,
        },
        token,
    )
    created = next(
        (event["data"] for event in events if event["event"] == "message.created"), {}
    )
    assistant_id = created.get("assistant_message_id")
    answer = answer_text(events)
    citations = citations_from_events(events)
    trace = (
        http_json("GET", f"/api/conversations/{conv_id}/messages/{assistant_id}/traces", token=token)
        if assistant_id
        else {}
    )
    messages = http_json("GET", f"/api/conversations/{conv_id}/messages", token=token)
    assistant = next(
        (
            msg
            for msg in messages.get("messages", [])
            if msg.get("message_id") == assistant_id
        ),
        {},
    )

    retrieval_text = "\n".join(
        item.get("content_preview", "")
        for item in trace.get("retrieval_traces", [])
    )
    citation_text = "\n".join(c.get("quote", "") for c in citations)
    combined = normalize("\n".join([answer, citation_text, retrieval_text]))

    expected_terms = case.get("expected_terms") or []
    missing_terms = [term for term in expected_terms if normalize(term) not in combined]

    expected_doc_ids = case.get("expected_doc_ids") or []
    expected_uploaded_doc_ids = {doc_id_map[doc_id] for doc_id in expected_doc_ids}
    cited_doc_ids = {c.get("doc_id") for c in citations}
    retrieved_doc_ids = {item.get("doc_id") for item in trace.get("retrieval_traces", [])}
    target_doc_hit = not expected_uploaded_doc_ids or bool(
        expected_uploaded_doc_ids & (cited_doc_ids | retrieved_doc_ids)
    )

    no_answer_expected = bool(case.get("expected_no_answer"))
    no_answer_text_markers = ["无法确认", "未找到", "没有", "未提及", "不足"]
    no_answer_actual = bool(assistant.get("no_answer_reason"))
    if no_answer_expected and not no_answer_actual:
        no_answer_actual = any(marker in answer for marker in no_answer_text_markers)
    no_answer_ok = (no_answer_actual if no_answer_expected else not no_answer_actual)

    prompt_mode = (
        ((trace.get("agent_trace") or {}).get("prompt_versions") or {}).get("mode")
    )
    expected_mode = case.get("expected_mode")
    mode_ok = not expected_mode or prompt_mode == f"mode-{expected_mode}-v1"

    citation_ok = no_answer_expected or len(citations) > 0
    terms_ok = len(missing_terms) == 0
    passed = terms_ok and target_doc_hit and no_answer_ok and mode_ok and citation_ok

    return {
        "id": case["id"],
        "passed": passed,
        "question": question,
        "answer": answer,
        "assistant_message_id": assistant_id,
        "citation_count": len(citations),
        "cited_doc_ids": sorted(cited_doc_ids),
        "retrieved_doc_ids": sorted(retrieved_doc_ids),
        "expected_doc_ids": expected_doc_ids,
        "expected_uploaded_doc_ids": sorted(expected_uploaded_doc_ids),
        "target_doc_hit": target_doc_hit,
        "missing_terms": missing_terms,
        "no_answer_expected": no_answer_expected,
        "no_answer_actual": no_answer_actual,
        "no_answer_ok": no_answer_ok,
        "mode": prompt_mode,
        "mode_ok": mode_ok,
        "citation_ok": citation_ok,
    }


def summarize(results, baseline):
    total = len(results)
    passed = sum(1 for item in results if item["passed"])
    normal = [item for item in results if not item["no_answer_expected"]]
    no_answer = [item for item in results if item["no_answer_expected"]]
    metrics = {
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "overall_pass_rate": passed / total if total else 0.0,
        "citation_coverage_rate": (
            sum(1 for item in normal if item["citation_ok"]) / len(normal)
            if normal
            else 1.0
        ),
        "target_doc_hit_rate": (
            sum(1 for item in normal if item["target_doc_hit"]) / len(normal)
            if normal
            else 1.0
        ),
        "no_answer_accuracy": (
            sum(1 for item in no_answer if item["no_answer_ok"]) / len(no_answer)
            if no_answer
            else 1.0
        ),
        "mode_selection_accuracy": (
            sum(1 for item in results if item["mode_ok"]) / total if total else 0.0
        ),
    }
    gates = {
        "overall_pass_rate": metrics["overall_pass_rate"]
        >= baseline.get("min_overall_pass_rate", 0.0),
        "citation_coverage_rate": metrics["citation_coverage_rate"]
        >= baseline.get("min_citation_coverage_rate", 0.0),
        "target_doc_hit_rate": metrics["target_doc_hit_rate"]
        >= baseline.get("min_target_doc_hit_rate", 0.0),
        "no_answer_accuracy": metrics["no_answer_accuracy"]
        >= baseline.get("min_no_answer_accuracy", 0.0),
    }
    return metrics, gates


def main():
    parser = argparse.ArgumentParser(description="Run DocuMind golden evaluation.")
    parser.add_argument("--golden", default=str(DEFAULT_GOLDEN))
    parser.add_argument("--output", default="")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    golden = load_json(args.golden)
    login = http_json(
        "POST",
        "/api/v1/auth/login",
        {"email": LOGIN_EMAIL, "password": LOGIN_PASSWORD},
    )
    token = login.get("access_token")
    kb_ids = login.get("allowed_kb_ids") or []
    if not token or not kb_ids:
        fail("login did not return token and knowledge base ids", login)
    kb_id = os.environ.get("KB_ID") or kb_ids[0]

    run_marker = os.environ.get("GOLDEN_RUN_MARKER") or f"run-{uuid.uuid4().hex[:8]}"
    print(f"golden run marker: {run_marker}")

    with tempfile.TemporaryDirectory(prefix="documind-golden-") as tmpdir:
        doc_id_map = {}
        for doc in golden["documents"]:
            path = materialize_document(tmpdir, doc, run_marker)
            uploaded = multipart_upload(f"/api/knowledge-bases/{kb_id}/documents", path, token)
            doc_id = uploaded["document_id"]
            doc_id_map[doc["id"]] = doc_id
            print(f"uploaded fixture {doc['id']} -> {doc_id}")
        for doc_id in doc_id_map.values():
            poll_indexed(doc_id, token)

    cases = []
    for case in golden["cases"][: args.limit or None]:
        marked = dict(case)
        marked["question"] = mark_text(case["question"], run_marker)
        cases.append(marked)
    results = []
    for index, case in enumerate(cases, start=1):
        print(f"[{index}/{len(cases)}] {case['id']} {case['question']}")
        try:
            result = run_case(token, kb_id, case, doc_id_map)
        except (urllib.error.HTTPError, RuntimeError, TimeoutError) as err:
            result = {
                "id": case["id"],
                "passed": False,
                "question": case["question"],
                "error": str(err),
                "citation_count": 0,
                "target_doc_hit": False,
                "no_answer_expected": bool(case.get("expected_no_answer")),
                "no_answer_actual": False,
                "no_answer_ok": False,
                "mode_ok": False,
                "citation_ok": False,
            }
        print("PASS" if result["passed"] else "FAIL", case["id"])
        results.append(result)

    metrics, gates = summarize(results, golden.get("baseline") or {})
    report = {
        "schema_version": "documind.golden.report.v1",
        "base_url": BASE_URL,
        "golden": golden["name"],
        "run_marker": run_marker,
        "metrics": metrics,
        "gates": gates,
        "uploaded_documents": doc_id_map,
        "results": results,
    }
    print(json.dumps({"metrics": metrics, "gates": gates}, ensure_ascii=False, indent=2))

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"wrote report: {output_path}")

    if not all(gates.values()):
        fail("golden evaluation gates failed", {"metrics": metrics, "gates": gates})


if __name__ == "__main__":
    main()
