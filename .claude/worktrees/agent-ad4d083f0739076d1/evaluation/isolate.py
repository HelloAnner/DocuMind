"""D02/D08 隔离：专用评测租户 + 专用评测账号 + 可核验销毁。

为什么用专用账号：平台管理员 Anner 一旦加入评测租户，平台登录会绑定到
最近加入的租户，从而无法再删除该租户。因此评测租户由独立账号持有，
平台管理员只负责创建与最终删除。

隔离等级：同一部署内的独立租户命名空间（tenant_namespace），
不是独立数据库实例；差异在报告中披露。所有写入都由服务端按 tenant
限定，评测结束删除租户行并逐表核验零残留。
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .core import RunContext, atomic_write_json, utc_iso
from .dmcli import CLIResult, DocuMindCLI

CLI_CONFIG_TEMPLATE = """version = 1

[server]
url = "{server_url}"
base_path = ""
timeout_seconds = 300

[auth]
username = "{username}"
password = ""
password_env = "{password_env}"
{tenant_line}

[chat]
kb_ids = []
trace = "full"
stream = true

[diagnostics]
ssh_host = "{ssh_host}"
elasticsearch_url = "{es_url}"
elasticsearch_index = "chunks_search"
"""


def write_cli_config(
    path: Path,
    *,
    server_url: str,
    username: str,
    password_env: str,
    ssh_host: str,
    es_url: str = "http://127.0.0.1:8104",
    tenant: str | None = None,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = CLI_CONFIG_TEMPLATE.format(
        server_url=server_url,
        username=username,
        password_env=password_env,
        tenant_line=f'tenant = "{tenant}"' if tenant else "",
        ssh_host=ssh_host,
        es_url=es_url,
    )
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)
    return path


@dataclass
class Isolation:
    tenant_id: str
    tenant_slug: str
    tenant_name: str
    eval_user_login: str
    eval_user_id: str | None
    platform_config: Path
    eval_config: Path
    invite_token: str
    platform_password_env: str = "DOCUMIND_PASSWORD"
    eval_password_env: str = "DOCUMIND_EVAL_PASSWORD"
    created_at: str = field(default_factory=utc_iso)

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": "tenant_namespace",
            "tenant_id": self.tenant_id,
            "tenant_slug": self.tenant_slug,
            "tenant_name": self.tenant_name,
            "eval_user_login": self.eval_user_login,
            "eval_user_id": self.eval_user_id,
            "platform_config": str(self.platform_config),
            "eval_config": str(self.eval_config),
            "invite_token_sha256": __import__("hashlib").sha256(
                self.invite_token.encode("utf-8")).hexdigest(),
            "created_at": self.created_at,
            "limitations": [
                "隔离为同一部署内的独立租户命名空间，不是独立数据库实例。",
                "评测账号为新建账号，不授予原 AcmeCorp 任何知识库权限。",
            ],
        }


def new_tenant_slug(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


def create_isolation(
    ctx: RunContext,
    *,
    cli_binary: Path,
    server_url: str,
    ssh_host: str,
    platform_password: str,
    eval_password: str,
    tenant_name_prefix: str = "DocuMind Eval",
    tenant_slug_prefix: str = "dm-eval",
    plan: str = "trial",
    remote: Any = None,
) -> tuple[Isolation, list[CLIResult]]:
    cli_dir = ctx.stage_dir("preparation") / "cli"
    results: list[CLIResult] = []
    platform_config = write_cli_config(
        cli_dir / "platform.toml",
        server_url=server_url, username="Anner", password_env="DOCUMIND_PASSWORD",
        ssh_host=ssh_host, tenant="acme",
    )
    platform = DocuMindCLI(
        cli_binary, platform_config, platform_password, server_url=server_url,
        cwd=ctx.root, ledger_path=ctx.path("preparation/cli-calls.jsonl"),
    )
    login = platform.run(["auth", "login", "--platform", "--json"])
    results.append(login)
    if not login.ok:
        raise RuntimeError(f"平台登录失败: {login.stderr[:400]}")
    scope = (login.json() or {}).get("scope")
    if scope != "platform":
        raise RuntimeError(f"平台登录未取得 platform 作用域: {scope}")

    slug = new_tenant_slug(tenant_slug_prefix)
    created = platform.run([
        "system", "tenant-create", "--name", f"{tenant_name_prefix} {slug}", "--slug", slug,
        "--plan", plan, "--json",
    ])
    results.append(created)
    if not created.ok:
        raise RuntimeError(f"创建评测租户失败: {created.stderr[:400]}")
    payload = created.json() or {}
    tenant_id = str(payload["tenant"]["id"])
    invite_url = str(payload["invitation"]["invite_url"])
    invite_token = invite_url.split("token=", 1)[1]

    eval_login_name = f"dm-eval-{secrets.token_hex(4)}"
    eval_config = write_cli_config(
        cli_dir / "eval-user.toml",
        server_url=server_url, username=eval_login_name, password_env="DOCUMIND_EVAL_PASSWORD",
        ssh_host=ssh_host, tenant=slug,
    )
    eval_cli = DocuMindCLI(
        cli_binary, eval_config, eval_password, server_url=server_url,
        cwd=ctx.root, ledger_path=ctx.path("preparation/cli-calls.jsonl"),
        password_env="DOCUMIND_EVAL_PASSWORD",
    )
    eval_user_id: str | None = None
    try:
        registered = eval_cli.run(["auth", "register", "--json"])
        results.append(registered)
        if not registered.ok:
            raise RuntimeError(f"注册评测账号失败: {registered.stderr[:400]} {registered.stdout[:300]}")
        eval_user_id = str(((registered.json() or {}).get("user") or {}).get("id") or "") or None

        accepted = eval_cli.run(["invitation", "accept", "--token", invite_token, "--json"])
        results.append(accepted)
        if not accepted.ok:
            raise RuntimeError(f"接受评测租户邀请失败: {accepted.stderr[:400]} {accepted.stdout[:300]}")
        accepted_payload = accepted.json() or {}
        if str(accepted_payload.get("tenant", {}).get("id") or "") != tenant_id:
            # accept 返回体结构不同则用 whoami 复核
            whoami = eval_cli.run(["auth", "whoami", "--json"])
            results.append(whoami)
            active = str(((whoami.json() or {}).get("tenant") or {}).get("id") or "")
            if active != tenant_id:
                raise RuntimeError(f"评测账号未落在评测租户: {active} != {tenant_id}")
    except Exception:
        # 补偿清理：租户一旦创建就登记 run 所有权，失败也必须销毁
        if remote is not None:
            try:
                remote.purge_tenant(tenant_id, user_ids=[eval_user_id] if eval_user_id else [])
            except Exception:  # noqa: BLE001
                pass
        atomic_write_json(ctx.path("preparation", "isolation-failed.json"), {
            "tenant_id": tenant_id, "tenant_slug": slug, "eval_user_id": eval_user_id,
            "compensated": remote is not None, "at": utc_iso(),
        })
        raise

    isolation = Isolation(
        tenant_id=tenant_id, tenant_slug=slug, tenant_name=f"{tenant_name_prefix} {slug}",
        eval_user_login=eval_login_name, eval_user_id=eval_user_id,
        platform_config=platform_config, eval_config=eval_config, invite_token=invite_token,
    )
    atomic_write_json(ctx.path("preparation/isolation.json"), isolation.as_dict())
    return isolation, results


def teardown_isolation(
    ctx: RunContext,
    isolation: Isolation,
    *,
    cli_binary: Path,
    server_url: str,
    ssh_host: str,
    platform_password: str,
    eval_password: str,
    remote: Any,
    kb_ids: list[str],
    doc_ids: list[str],
    conversation_ids: list[str],
    delete_cli_resources: bool = True,
) -> dict[str, Any]:
    """先经 CLI 删业务资源，再由平台删除租户，最后数据库硬清理与核验。"""
    from .core import atomic_write_json

    ledger: dict[str, Any] = {"at": utc_iso(), "steps": []}

    def step(name: str, payload: Any) -> None:
        ledger["steps"].append({"step": name, "at": utc_iso(), "payload": payload})

    stop = remote.stop_workers()
    step("stop_async_workers", stop)

    eval_cli = DocuMindCLI(
        cli_binary, isolation.eval_config, eval_password, server_url=server_url,
        cwd=ctx.root, ledger_path=ctx.path("preparation/cli-calls.jsonl"),
        password_env="DOCUMIND_EVAL_PASSWORD",
    )
    if delete_cli_resources:
        for conversation_id in conversation_ids:
            result = eval_cli.run(["conversations", "delete", conversation_id, "--json"])
            step("delete_conversation", {"id": conversation_id, "ok": result.ok,
                                         "stderr": result.stderr[:200]})
        for doc_id in doc_ids:
            result = eval_cli.run(["documents", "delete", doc_id, "--force", "--json"])
            step("delete_document", {"id": doc_id, "ok": result.ok, "stderr": result.stderr[:200]})
        for kb_id in kb_ids:
            result = eval_cli.run(["kb", "delete", kb_id, "--force", "--json"])
            step("delete_kb", {"id": kb_id, "ok": result.ok, "stderr": result.stderr[:200]})

    platform = DocuMindCLI(
        cli_binary, isolation.platform_config, platform_password, server_url=server_url,
        cwd=ctx.root, ledger_path=ctx.path("preparation/cli-calls.jsonl"),
    )
    marked = platform.run([
        "system", "tenant-delete", isolation.tenant_id, "--slug", isolation.tenant_slug,
        "--force", "--json",
    ])
    step("cli_tenant_delete", {
        "ok": marked.ok, "stdout": marked.stdout[:400], "stderr": marked.stderr[:300],
    })

    purge = remote.purge_tenant(
        isolation.tenant_id,
        user_ids=[isolation.eval_user_id] if isolation.eval_user_id else [],
    )
    step("db_hard_purge", purge)

    after = remote.tenant_residue(isolation.tenant_id)
    step("db_residue_after", after)
    es_count = remote.es_tenant_count(isolation.tenant_id)
    step("es_residue_after", {"count": es_count})
    user_after = None
    if isolation.eval_user_id:
        user_after = remote.scalar(
            f"SELECT count(*) FROM documind.app_user WHERE id = '{isolation.eval_user_id}'")
    step("eval_user_after", {"count": user_after})

    remaining = {table: count for table, count in after.items() if count != 0}
    checked = len(after)
    ledger.update({
        "cleanup_status": "verified" if (not remaining and es_count == 0 and user_after in (None, "0")) else "failed",
        "remaining": remaining,
        "es_remaining": es_count,
        "eval_user_remaining": user_after,
        "checked_tables": checked,
        "unchecked_tables": sum(1 for count in after.values() if count < 0),
    })
    atomic_write_json(ctx.path("cleanup.json"), ledger)
    return ledger
