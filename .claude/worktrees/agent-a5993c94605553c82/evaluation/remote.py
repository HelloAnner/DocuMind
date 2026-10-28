"""远端服务器只读核验与清理（SSH + podman psql + Elasticsearch）。

评估业务操作只经 CLI；本模块只做：
1. D02 基线枚举（读取原有租户/知识库状态）；
2. D08 清理：先阻断异步写入，再销毁评测租户全部状态；
3. D08 零残留核验：数据库逐表计数 + Elasticsearch 文档计数。
所有删除都按 run 自有的 tenant_id / user_id 精确限定，绝不触碰共享资源。
"""

from __future__ import annotations

import json
import subprocess
from typing import Any, Sequence

from .core import sha256_text, utc_iso

PG_CONTAINER = "documind-postgres"
PG_USER = "documind"
PG_DATABASE = "documind_dev"
PG_SCHEMA = "documind"
ES_URL = "http://127.0.0.1:8104"
ES_INDEX = "chunks_search"

# 有 tenant_id 列但没有 ON DELETE CASCADE 外键的表，必须显式按依赖顺序删除
EXPLICIT_PURGE_ORDER: tuple[str, ...] = (
    "conversation_message_file",
    "conversation_messages",
    "conversation_shares",
    "conversation_sessions",
    "document_source_anchors",
    "knowledge_base_acl",
    "vector_jobs",
    "audit_log",
)


class RemoteError(RuntimeError):
    pass


class Remote:
    def __init__(self, ssh_host: str, timeout_seconds: int = 120) -> None:
        self.ssh_host = ssh_host
        self.timeout_seconds = timeout_seconds
        self._tenant_tables: list[str] | None = None

    # ------------------------------------------------------------ SSH 基础

    def ssh(self, script: str, *, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["ssh", "-o", "BatchMode=yes", self.ssh_host, script],
            capture_output=True, text=True, timeout=timeout or self.timeout_seconds,
        )

    def _psql(self, sql: str) -> subprocess.CompletedProcess[str]:
        script = (
            f"podman exec {PG_CONTAINER} psql -U {PG_USER} -d {PG_DATABASE} "
            f"-t -A -F'|' -v ON_ERROR_STOP=1 -c {json.dumps(sql)}"
        )
        return self.ssh(script, timeout=max(self.timeout_seconds, 180))

    def query(self, sql: str) -> list[list[str]]:
        proc = self._psql(sql)
        if proc.returncode != 0:
            raise RemoteError(f"psql 失败: {proc.stderr.strip()[:500]}")
        rows: list[list[str]] = []
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line or line.startswith("Emulate Docker CLI"):
                continue
            rows.append(line.split("|"))
        return rows

    def scalar(self, sql: str) -> str:
        rows = self.query(sql)
        return rows[0][0] if rows and rows[0] else ""

    # ------------------------------------------------------------ 数据库结构

    def tenant_tables(self) -> list[str]:
        if self._tenant_tables is None:
            rows = self.query(
                "SELECT table_name FROM information_schema.columns "
                "WHERE table_schema = 'documind' AND column_name = 'tenant_id' ORDER BY table_name"
            )
            self._tenant_tables = [row[0] for row in rows]
        return self._tenant_tables

    def tenant_residue(self, tenant_id: str) -> dict[str, int]:
        counts: dict[str, int] = {}
        for table in self.tenant_tables():
            try:
                value = self.scalar(
                    f"SELECT count(*) FROM {PG_SCHEMA}.\"{table}\" WHERE tenant_id = '{tenant_id}'"
                )
                counts[table] = int(value)
            except RemoteError:
                counts[table] = -1
        try:
            counts["tenant"] = int(
                self.scalar(f"SELECT count(*) FROM {PG_SCHEMA}.tenant WHERE id = '{tenant_id}'")
            )
        except RemoteError:
            counts["tenant"] = -1
        return counts

    # ------------------------------------------------------------ 基线

    def baseline_snapshot(self) -> dict[str, Any]:
        tenant_count = int(self.scalar(f"SELECT count(*) FROM {PG_SCHEMA}.tenant"))
        user_count = int(self.scalar(f"SELECT count(*) FROM {PG_SCHEMA}.app_user"))
        return {
            "tenant_count": tenant_count,
            "app_user_count": user_count,
            "tenant_ids": [
                [row[0], row[1], row[2]] for row in self.query(
                    f"SELECT id, slug, status FROM {PG_SCHEMA}.tenant ORDER BY slug"
                )
            ],
            "observed_at": utc_iso(),
        }

    # ------------------------------------------------------------ 清理

    def purge_tenant(self, tenant_id: str, *, user_ids: Sequence[str] = ()) -> dict[str, Any]:
        statements: list[str] = []
        for table in EXPLICIT_PURGE_ORDER:
            if table in self.tenant_tables():
                statements.append(
                    f"DELETE FROM {PG_SCHEMA}.\"{table}\" WHERE tenant_id = '{tenant_id}'"
                )
        statements.append(f"DELETE FROM {PG_SCHEMA}.tenant WHERE id = '{tenant_id}'")
        for user_id in user_ids:
            statements.append(
                f"DELETE FROM {PG_SCHEMA}.app_user WHERE id = '{user_id}' "
                f"AND NOT EXISTS (SELECT 1 FROM {PG_SCHEMA}.tenant_member tm WHERE tm.user_id = '{user_id}')"
            )
        proc = self._psql("BEGIN; " + "; ".join(statements) + "; COMMIT;")
        if proc.returncode != 0:
            raise RemoteError(f"清理失败: {proc.stderr.strip()[:800]}")
        return {
            "tenant_id": tenant_id,
            "user_ids": list(user_ids),
            "statements": statements,
            "at": utc_iso(),
            "stdout_sha256": sha256_text(proc.stdout),
        }

    def delete_user(self, user_id: str) -> None:
        proc = self._psql(f"DELETE FROM {PG_SCHEMA}.app_user WHERE id = '{user_id}'")
        if proc.returncode != 0:
            raise RemoteError(f"删除用户失败: {proc.stderr.strip()[:400]}")

    def lookup_user(self, login_id: str) -> str | None:
        rows = self.query(f"SELECT id FROM {PG_SCHEMA}.app_user WHERE lower(login_id) = lower('{login_id}')")
        return rows[0][0] if rows else None

    # ------------------------------------------------------------ Elasticsearch

    def es_tenant_count(self, tenant_id: str) -> int:
        payload = json.dumps({"query": {"term": {"tenant_id": tenant_id}}})
        script = (
            f"curl -s -m 20 -H 'Content-Type: application/json' "
            f"'{ES_URL}/{ES_INDEX}-*/_count' -d {json.dumps(payload)}"
        )
        proc = self.ssh(script)
        if proc.returncode != 0:
            raise RemoteError(f"ES 查询失败: {proc.stderr.strip()[:400]}")
        try:
            return int(json.loads(proc.stdout.strip().splitlines()[-1]).get("count", -1))
        except (ValueError, IndexError) as exc:
            raise RemoteError(f"ES 响应无法解析: {proc.stdout[:200]}") from exc

    def es_tenant_chunk_ids(self, tenant_id: str, limit: int = 200) -> list[str]:
        payload = json.dumps({
            "size": limit, "query": {"term": {"tenant_id": tenant_id}}, "_source": False,
        })
        script = (
            f"curl -s -m 20 -H 'Content-Type: application/json' "
            f"'{ES_URL}/{ES_INDEX}-*/_search' -d {json.dumps(payload)}"
        )
        proc = self.ssh(script)
        if proc.returncode != 0:
            raise RemoteError(f"ES 查询失败: {proc.stderr.strip()[:400]}")
        try:
            body = json.loads(proc.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError) as exc:
            raise RemoteError(f"ES 响应无法解析: {proc.stdout[:200]}") from exc
        return [hit.get("_id", "") for hit in body.get("hits", {}).get("hits", [])]

    def stop_workers(self) -> dict[str, Any]:
        """阻断可能重建索引的异步写入：先停向量/解析 worker，再销毁状态。"""
        script = (
            "for c in documind-worker documind-vector-worker documind-indexer; do "
            "  podman pause $c 2>/dev/null && echo paused:$c; "
            "done; true"
        )
        proc = self.ssh(script)
        return {"stdout": proc.stdout.strip(), "returncode": proc.returncode, "at": utc_iso()}
