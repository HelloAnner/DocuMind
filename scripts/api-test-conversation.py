#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:8089").rstrip("/")
LOGIN_EMAIL = os.environ.get("LOGIN_EMAIL", "Anner")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "1")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "180"))
CHECK_COUNT = 0


def fail(message, details=None):
    print(f"FAIL: {message}")
    if details is not None:
        print(json.dumps(details, ensure_ascii=False, indent=2))
    raise SystemExit(1)


def ok(message):
    global CHECK_COUNT
    CHECK_COUNT += 1
    print(f"PASS: {message}")


def http_json(method, path, payload=None, token=None):
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
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = body
        raise RuntimeError(
            json.dumps(
                {"status": err.code, "path": path, "body": parsed},
                ensure_ascii=False,
            )
        )


def expect_http_error(method, path, payload=None, token=None, code=None):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        parsed = json.loads(body)
        if parsed.get("code") != code:
            fail(f"expected {code}, got {parsed.get('code')}", parsed)
        ok(f"{path} rejects request with {code}")
        return
    fail(f"{path} unexpectedly accepted invalid request")


def multipart_upload(path, file_path, token):
    boundary = f"----documind{uuid.uuid4().hex}"
    filename = file_path.name
    content = file_path.read_bytes()
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            (
                f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n"
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


def create_test_docs(tmpdir):
    docs = {
        "2026-Q3采购合同-API测试.docx": [
            "DocuMind API测试采购合同。",
            "付款节点：合同签署后支付首付款30%，验收通过后支付60%，质保期结束且无质量问题后支付10%。",
            "违约责任：任何一方未按约定履行合同义务，应向对方支付合同金额10%的违约金。",
            "验收标准：交付物需经业务负责人书面验收，验收记录是后续付款依据。",
        ],
        "员工报销制度-API测试.docx": [
            "DocuMind API测试员工报销制度。",
            "员工报销提交时限：费用发生后30个工作日内提交。",
            "报销材料包括发票原件、费用明细、审批单；缺少审批单时不得进入付款流程。",
        ],
        "华东销售策略-API测试.docx": [
            "DocuMind API测试华东销售策略。",
            "Q3华东区域销售目标为1200万元，较去年同期增长15%，其中新客户占比不低于30%。",
            "重点客户推进节奏按月复盘，销售负责人每周更新风险清单。",
        ],
    }
    paths = []
    for name, paragraphs in docs.items():
        path = Path(tmpdir) / name
        write_docx(path, paragraphs)
        paths.append(path)
    return paths


def poll_indexed(doc_id, token):
    deadline = time.time() + POLL_SECONDS
    last = None
    while time.time() < deadline:
        detail = http_json("GET", f"/api/admin/documents/{doc_id}", token=token)
        doc = detail.get("document", {})
        status = doc.get("parse_status")
        chunks = doc.get("chunk_count")
        if status != last:
            print(f"document {doc_id} status={status} chunks={chunks}")
            last = status
        if status == "indexed":
            if not chunks:
                fail("indexed document has no chunks", detail)
            return detail
        if status in {"parse_failed", "embedding_failed", "parse_low_confidence"}:
            fail(f"document {doc_id} failed to index", detail)
        time.sleep(3)
    fail(f"document {doc_id} did not become indexed in time")


def validate_pg_embeddings(doc_ids):
    sql_doc_ids = ",".join(f"'{doc_id}'" for doc_id in doc_ids)
    sql = f"""
SET search_path TO documind, public;
SELECT doc_id, count(*) AS chunks,
       (SELECT count(*) FROM chunk_embeddings e
        WHERE e.doc_id = c.doc_id AND e.status = 'completed') AS embeddings
FROM chunks c
WHERE doc_id IN ({sql_doc_ids})
GROUP BY doc_id
ORDER BY doc_id;
"""
    try:
        result = subprocess.run(
            [
                "docker",
                "exec",
                "documind-postgres",
                "psql",
                "-U",
                "documind",
                "-d",
                "documind_dev",
                "-qAtX",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                sql,
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )
    except Exception as exc:
        print(f"WARN: skipping PG embedding validation: {exc}")
        return

    seen = set()
    for line in result.stdout.splitlines():
        doc_id, chunks, embeddings = line.split("|")
        chunks = int(chunks)
        embeddings = int(embeddings)
        if chunks <= 0 or embeddings < chunks:
            fail("PG chunks/embeddings validation failed", {
                "doc_id": doc_id,
                "chunks": chunks,
                "embeddings": embeddings,
            })
        seen.add(doc_id)
    missing = set(doc_ids) - seen
    if missing:
        fail("PG validation missed documents", sorted(missing))
    ok("PostgreSQL chunks and vector embeddings are present")


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
    with urllib.request.urlopen(req, timeout=180) as resp:
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


def require_event(events, name):
    if not any(event["event"] == name for event in events):
        fail(f"missing SSE event {name}", events)


def assert_contains(text, needles, label):
    missing = [needle for needle in needles if needle not in text]
    if missing:
        fail(f"{label} missing expected text {missing}", {"text": text})


def assert_trace(token, conv_id, assistant_id, expected_mode=None, plan_mode=None, preview_terms=None):
    trace = http_json(
        "GET", f"/api/conversations/{conv_id}/messages/{assistant_id}/traces", token=token
    )
    agent_trace = trace.get("agent_trace") or {}
    query_trace = trace.get("query_trace") or {}
    retrieval_traces = trace.get("retrieval_traces") or []
    if expected_mode and agent_trace.get("prompt_versions", {}).get("mode") != f"mode-{expected_mode}-v1":
        fail("unexpected agent mode in trace", trace)
    if plan_mode and agent_trace.get("retrieval_plan", {}).get("mode") != plan_mode:
        fail("unexpected retrieval plan mode", trace)
    sources = {item.get("source") for item in retrieval_traces}
    if "rerank" not in sources or not ({"dense", "rrf"} & sources):
        fail("trace must include hybrid retrieval and rerank records", trace)
    if preview_terms:
        joined = "\n".join(item.get("content_preview", "") for item in retrieval_traces)
        assert_contains(joined, preview_terms, "retrieval trace preview")
    if not query_trace.get("rewritten_query"):
        fail("query trace missing rewritten query", trace)
    return trace


def run_question(token, conv_id, content, require_pipeline_events=True):
    events = sse_post(
        f"/api/conversations/{conv_id}/messages",
        {
            "content": content,
            "kb_ids": [],
            "client_request_id": f"api-test-{uuid.uuid4()}",
            "stream": True,
        },
        token,
    )
    required_events = ["message.created", "answer.delta", "answer.completed"]
    if require_pipeline_events:
        required_events[1:1] = [
            "status.updated",
            "rewrite.completed",
            "retrieval.completed",
            "rerank.completed",
        ]
    for name in required_events:
        require_event(events, name)
    created = next(event for event in events if event["event"] == "message.created")["data"]
    return events, created["assistant_message_id"], created["user_message_id"]


def expect_sse_http_error(path, payload, token, code):
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
    try:
        urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        parsed = json.loads(body)
        if parsed.get("code") != code:
            fail(f"expected {code}, got {parsed.get('code')}", parsed)
        ok(f"{path} rejects stream request with {code}")
        return
    fail(f"{path} unexpectedly accepted invalid stream request")


def assert_list_contains(items, predicate, label):
    if not any(predicate(item) for item in items):
        fail(f"{label} not found", items)
    ok(f"{label} found")


def assert_login_identity(login):
    user = login.get("user") or {}
    roles = login.get("roles") or []
    permissions = set(login.get("permissions") or [])
    if user.get("email") != LOGIN_EMAIL:
        fail("login returned unexpected user", login)
    if "super_admin" not in roles:
        fail("Anner must be a super_admin", login)
    required = {"tenant.read", "user.read", "kb.manage", "document.upload", "chat.ask"}
    missing = sorted(required - permissions)
    if missing:
        fail("super_admin permissions missing", {"missing": missing, "login": login})
    ok("Anner login returns super_admin role and required permissions")


def assert_message_persisted(token, conv_id, user_id, assistant_id, content_terms):
    messages = http_json("GET", f"/api/conversations/{conv_id}/messages", token=token)
    rows = messages.get("messages") or []
    user = next((item for item in rows if item["message_id"] == user_id), None)
    assistant = next((item for item in rows if item["message_id"] == assistant_id), None)
    if not user or not assistant:
        fail("conversation messages were not persisted", messages)
    if assistant.get("status") != "completed":
        fail("assistant message did not complete", assistant)
    assert_contains(assistant.get("content", ""), content_terms, "persisted assistant content")
    ok("user and assistant messages are persisted after answer.completed")
    return assistant


def main():
    expect_http_error("GET", "/api/me", token=None, code="UNAUTHORIZED")
    expect_http_error(
        "POST",
        "/api/conversations",
        {"title": "No Auth", "kb_ids": []},
        token=None,
        code="UNAUTHORIZED",
    )
    expect_http_error(
        "POST",
        "/api/v1/auth/login",
        {"email": LOGIN_EMAIL, "password": "wrong-password"},
        token=None,
        code="UNAUTHORIZED",
    )

    login = http_json(
        "POST",
        "/api/v1/auth/login",
        {"email": LOGIN_EMAIL, "password": LOGIN_PASSWORD},
    )
    assert_login_identity(login)
    token = login.get("access_token")
    kb_ids = login.get("allowed_kb_ids") or []
    if not token or not kb_ids:
        fail("login did not return token and knowledge base scope", login)
    kb_id = os.environ.get("KB_ID") or kb_ids[0]
    ok(f"login succeeded, kb_id={kb_id}")

    me = http_json("GET", "/api/me", token=token)
    if me.get("user", {}).get("email") != LOGIN_EMAIL:
        fail("/api/me returned unexpected user", me)
    ok("/api/me returns the logged-in Anner identity")

    permission_me = http_json("GET", "/api/v1/permission/me", token=token)
    assert_list_contains(permission_me.get("roles", []), lambda role: role == "super_admin", "permission role super_admin")
    matrix = http_json("GET", "/api/v1/permission/matrix", token=token)
    if "super_admin" not in (matrix.get("roles") or {}):
        fail("permission matrix missing super_admin", matrix)
    ok("permission matrix exposes super_admin")

    for path in [
        "/api/system/overview",
        "/api/system/tenants",
        "/api/system/users",
        "/api/system/models",
        "/api/system/jobs",
    ]:
        http_json("GET", path, token=token)
        ok(f"{path} accepts super_admin")

    users = http_json("GET", "/api/system/users", token=token)
    assert_list_contains(users, lambda item: item.get("email") == LOGIN_EMAIL, "system user Anner")

    knowledge_bases = http_json("GET", "/api/knowledge-bases", token=token)
    assert_list_contains(knowledge_bases, lambda item: item.get("id") == kb_id, "allowed knowledge base")

    with tempfile.TemporaryDirectory(prefix="documind-api-test-") as tmpdir:
        doc_paths = create_test_docs(tmpdir)
        doc_ids = []
        for path in doc_paths:
            upload = multipart_upload(f"/api/knowledge-bases/{kb_id}/documents", path, token)
            doc_id = upload["document_id"]
            doc_ids.append(doc_id)
            print(f"uploaded {path.name}: {doc_id}")
        for doc_id in doc_ids:
            detail = poll_indexed(doc_id, token)
            title = (detail.get("document") or {}).get("title", "")
            if "API测试" not in title:
                fail("indexed document title is unexpected", detail)
            ok(f"document detail persisted after indexing: {title}")
        ok("documents uploaded and indexed through API")

    validate_pg_embeddings(doc_ids)

    conversations_before = http_json("GET", "/api/conversations?limit=50", token=token)
    ok("conversation history list is readable before new conversations")

    conv = http_json(
        "POST",
        "/api/conversations",
        {"title": "API Test Agent Conversation", "kb_ids": [kb_id]},
        token=token,
    )
    conv_id = conv["conversation_id"]
    ok(f"conversation created: {conv_id}")

    history = http_json("GET", "/api/conversations?limit=50", token=token)
    assert_list_contains(
        history.get("items", []),
        lambda item: item.get("conversation_id") == conv_id,
        "new conversation in history list",
    )

    expect_http_error(
        "POST",
        f"/api/conversations/{conv_id}/messages",
        {"content": "   ", "kb_ids": [kb_id], "stream": True},
        token,
        "EMPTY_MESSAGE",
    )

    fixed_client_request_id = f"api-test-fixed-{uuid.uuid4()}"
    fixed_events = sse_post(
        f"/api/conversations/{conv_id}/messages",
        {
            "content": "DocuMind API测试采购合同的付款节点是什么？",
            "kb_ids": [],
            "client_request_id": fixed_client_request_id,
            "stream": True,
        },
        token,
    )
    for name in [
        "message.created",
        "status.updated",
        "rewrite.completed",
        "retrieval.completed",
        "rerank.completed",
        "answer.delta",
        "answer.completed",
    ]:
        require_event(fixed_events, name)
    created = next(event for event in fixed_events if event["event"] == "message.created")["data"]
    assistant_id = created["assistant_message_id"]
    user_id = created["user_message_id"]
    text = answer_text(fixed_events)
    assert_contains(text, ["30%", "60%", "10%"], "payment answer")
    assert_trace(token, conv_id, assistant_id, "answerer", "single", ["付款节点"])
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["30%", "60%", "10%"])
    ok("single-turn document answer returns correct payment facts with trace")

    expect_sse_http_error(
        f"/api/conversations/{conv_id}/messages",
        {
            "content": "DocuMind API测试采购合同的付款节点是什么？",
            "kb_ids": [],
            "client_request_id": fixed_client_request_id,
            "stream": True,
        },
        token,
        "CLIENT_REQUEST_CONFLICT",
    )

    feedback = http_json(
        "POST",
        f"/api/conversations/{conv_id}/messages/{assistant_id}/feedback",
        {"rating": "up", "reason": "helpful", "comment": "API test helpful"},
        token=token,
    )
    if not feedback.get("feedback_id"):
        fail("feedback response missing id", feedback)
    ok("feedback is accepted for completed assistant message")

    expect_http_error(
        "POST",
        f"/api/conversations/{conv_id}/messages/{assistant_id}/cancel",
        {},
        token,
        "INVALID_MESSAGE_STATE",
    )
    expect_sse_http_error(
        f"/api/conversations/{conv_id}/messages/{assistant_id}/retry",
        {"stream": True},
        token,
        "INVALID_MESSAGE_STATE",
    )

    events, assistant_id, user_id = run_question(
        token, conv_id, "请说明 DocuMind API测试采购合同的三个付款比例"
    )
    text = answer_text(events)
    assert_contains(text, ["30%", "60%", "10%"], "payment answer")
    assert_trace(token, conv_id, assistant_id, "answerer", "single", ["付款节点"])
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["30%", "60%", "10%"])
    ok("second phrasing document answer returns correct payment facts with full pipeline events")

    events, assistant_id, user_id = run_question(token, conv_id, "那它的违约责任是什么？")
    text = answer_text(events)
    assert_contains(text, ["违约", "10%"], "follow-up answer")
    trace = assert_trace(token, conv_id, assistant_id, "answerer", "single", ["违约责任"])
    rewritten = trace.get("query_trace", {}).get("rewritten_query", "")
    assert_contains(rewritten, ["采购合同"], "resolved follow-up query")
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["违约", "10%"])
    ok("multi-turn pronoun follow-up is resolved and router self-corrects to answerer")

    events, assistant_id, user_id = run_question(
        token, conv_id, "请总结 DocuMind API测试采购合同讲了什么"
    )
    text = answer_text(events)
    assert_contains(text, ["核心内容", "付款"], "summary answer")
    assert_trace(token, conv_id, assistant_id, "summarizer", "single", ["付款节点"])
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["核心内容", "付款"])
    ok("summarizer mode produces grounded answer")

    events, assistant_id, user_id = run_question(
        token, conv_id, "对比 DocuMind API测试采购合同付款节点 和 员工报销制度提交时限"
    )
    text = answer_text(events)
    assert_contains(text, ["30%", "60%", "10%", "30个工作日"], "comparison answer")
    assert_trace(
        token,
        conv_id,
        assistant_id,
        "comparer",
        "multi",
        ["付款节点", "报销提交时限"],
    )
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["30%", "30个工作日"])
    ok("comparer mode uses multi-query retrieval and evidence from both documents")

    events, assistant_id, user_id = run_question(
        token, conv_id, "采购合同付款依赖验收记录是否存在流程风险？"
    )
    text = answer_text(events)
    assert_contains(text, ["人工确认", "验收"], "analyst answer")
    assert_trace(token, conv_id, assistant_id, "analyst", "single", ["验收"])
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["人工确认", "验收"])
    ok("analyst mode stays inside evidence boundary")

    events, assistant_id, user_id = run_question(token, conv_id, "员工报销提交时限是多少？")
    text = answer_text(events)
    assert_contains(text, ["30个工作日"], "reimbursement answer")
    assert_trace(token, conv_id, assistant_id, "answerer", "single", ["报销提交时限"])
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["30个工作日"])
    ok("second document can be retrieved accurately")

    events, assistant_id, user_id = run_question(token, conv_id, "Q3华东区域销售目标是多少？")
    text = answer_text(events)
    assert_contains(text, ["1200万元", "15%", "30%"], "sales answer")
    assert_trace(token, conv_id, assistant_id, "answerer", "single", ["Q3华东区域销售目标"])
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["1200万元", "15%", "30%"])
    ok("third document can be retrieved accurately")

    events, assistant_id, user_id = run_question(token, conv_id, "付款节点在哪个材料里提到？")
    text = answer_text(events)
    assert_contains(text, ["付款", "30%"], "navigator answer")
    assert_trace(token, conv_id, assistant_id, "navigator", "single", ["付款节点"])
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["付款", "30%"])
    ok("navigator mode uses document evidence")

    events, assistant_id, user_id = run_question(token, conv_id, "检查采购合同付款流程是否完整")
    text = answer_text(events)
    assert_contains(text, ["付款", "验收"], "reviewer answer")
    assert_trace(token, conv_id, assistant_id, "reviewer", "single", ["付款节点"])
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["付款", "验收"])
    ok("reviewer mode is traced and grounded")

    events, assistant_id, user_id = run_question(token, conv_id, "火星基地预算是多少？")
    text = answer_text(events)
    assert_contains(text, ["未找到"], "no-answer response")
    messages = http_json("GET", f"/api/conversations/{conv_id}/messages", token=token)
    assistant = next(
        item for item in messages["messages"] if item["message_id"] == assistant_id
    )
    if assistant.get("no_answer_reason") != "NO_RELEVANT_CHUNKS":
        fail("irrelevant question should persist NO_RELEVANT_CHUNKS", assistant)
    assert_message_persisted(token, conv_id, user_id, assistant_id, ["未找到"])
    assert_trace(token, conv_id, assistant_id, "answerer", "single")
    ok("irrelevant question returns explicit no-answer state")

    conv2 = http_json(
        "POST",
        "/api/conversations",
        {"title": "API Test History Conversation", "kb_ids": [kb_id]},
        token=token,
    )
    conv2_id = conv2["conversation_id"]
    ok(f"second conversation created: {conv2_id}")
    events, assistant_id, user_id = run_question(token, conv2_id, "销售负责人多久更新风险清单？")
    text = answer_text(events)
    assert_contains(text, ["每周", "风险清单"], "second conversation answer")
    assert_trace(token, conv2_id, assistant_id, "analyst", "single", ["风险清单"])
    assert_message_persisted(token, conv2_id, user_id, assistant_id, ["每周", "风险清单"])
    ok("second conversation stores independent messages")

    history = http_json("GET", "/api/conversations?limit=50", token=token)
    history_items = history.get("items", [])
    assert_list_contains(history_items, lambda item: item.get("conversation_id") == conv_id, "first conversation in final history")
    assert_list_contains(history_items, lambda item: item.get("conversation_id") == conv2_id, "second conversation in final history")
    conv1_item = next(item for item in history_items if item.get("conversation_id") == conv_id)
    conv2_item = next(item for item in history_items if item.get("conversation_id") == conv2_id)
    if not conv1_item.get("last_message_preview") or not conv2_item.get("last_message_preview"):
        fail("history list missing last message previews", history)
    ok("conversation history records last message previews")

    final_messages = http_json("GET", f"/api/conversations/{conv_id}/messages", token=token)
    if len(final_messages.get("messages", [])) < 20:
        fail("first conversation did not persist all multi-turn messages", final_messages)
    ok("first conversation persisted the full multi-turn transcript")

    refresh = http_json("POST", "/api/v1/auth/refresh", {}, token=token)
    if not refresh.get("access_token"):
        fail("refresh did not return token", refresh)
    ok("auth refresh works for logged-in Anner")

    logout = http_json("POST", "/api/v1/auth/logout", {}, token=token)
    if logout.get("ok") is not True:
        fail("logout response is unexpected", logout)
    ok("logout endpoint returns ok")

    print(f"ALL API TESTS PASSED ({CHECK_COUNT} checks)")


if __name__ == "__main__":
    main()
