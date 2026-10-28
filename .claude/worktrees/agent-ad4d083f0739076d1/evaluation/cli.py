"""评估命令行入口：python -m evaluation run|render|status。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import load_config
from .core import latest_run_id, load_run
from .pipeline import regrade_run, run_evaluation
from .report import render_report


def _cmd_run(args: argparse.Namespace) -> int:
    result = run_evaluation(
        args.config, run_id=args.run_id, workspace_root=args.workspace_root,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _cmd_render(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    root = Path(args.workspace_root or config["workspace_root"])
    run_id = args.run_id or latest_run_id(root)
    if not run_id:
        print("没有可用 run", file=sys.stderr)
        return 2
    ctx = load_run(root, run_id)
    metrics = ctx.read_json("analysis/metrics.json")
    findings = ctx.read_json("analysis/findings.json", {})
    cases = ctx.read_jsonl("normalized/cases.jsonl")
    cleanup = ctx.read_json("cleanup.json", {}) or {}
    corpus = ctx.read_json("corpus/manifest.json", {}).get("documents", [])
    if not metrics:
        print("缺少 analysis/metrics.json，先运行 run", file=sys.stderr)
        return 2
    outcome_by_case = {row["case_id"]: row for row in metrics["cases"]}
    conversation_by_case = {record["case_id"]: record.get("conversation_id") for record in cases}
    verdict_by_case = {record["case_id"]: record for record in ctx.read_jsonl("grading/verdicts.jsonl")}
    summary = render_report(ctx, data={
        "title": config["report"]["title"], "metrics": metrics, "findings": findings,
        "cases": cases, "corpus": corpus, "manifest": ctx.manifest, "cleanup": cleanup,
        "outcome_by_case": outcome_by_case, "conversation_by_case": conversation_by_case,
        "verdict_by_case": verdict_by_case,
        "dataset_manifest": ctx.read_json("dataset/dataset_manifest.json", {}),
    }, revision=args.revision)
    print(json.dumps({"run_id": run_id, **summary}, ensure_ascii=False, indent=2))
    return 0


def _cmd_regrade(args: argparse.Namespace) -> int:
    result = regrade_run(
        args.config, run_id=args.run_id, workspace_root=args.workspace_root,
        revision=args.revision,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    root = Path(args.workspace_root or config["workspace_root"])
    run_id = args.run_id or latest_run_id(root)
    if not run_id:
        print("没有可用 run", file=sys.stderr)
        return 2
    ctx = load_run(root, run_id)
    print(json.dumps({"run_id": run_id, "manifest": ctx.manifest,
                      "stages": sorted(path.stem for path in ctx.path("execution").glob("*.json"))},
                     ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evaluation", description="DocuMind 隔离准确性评估")
    parser.add_argument("--config", default=None, help="JSON 覆盖配置路径")
    sub = parser.add_subparsers(dest="command", required=True)

    run_parser = sub.add_parser("run", help="执行 D01-D12 全流程")
    run_parser.add_argument("--config", default=None, help="JSON 覆盖配置路径")
    run_parser.add_argument("--run-id", default=None)
    run_parser.add_argument("--workspace-root", default=None)
    run_parser.set_defaults(func=_cmd_run)

    render_parser = sub.add_parser("render", help="用已有分析结果重新拼报告（离线）")
    render_parser.add_argument("--config", default=None, help="JSON 覆盖配置路径")
    render_parser.add_argument("--run-id", default=None)
    render_parser.add_argument("--workspace-root", default=None)
    render_parser.add_argument("--revision", default="r1")
    render_parser.set_defaults(func=_cmd_render)

    regrade_parser = sub.add_parser("regrade", help="用已有证据离线重跑评分与报告")
    regrade_parser.add_argument("--config", default=None, help="JSON 覆盖配置路径")
    regrade_parser.add_argument("--run-id", required=True)
    regrade_parser.add_argument("--workspace-root", default=None)
    regrade_parser.add_argument("--revision", default="r1")
    regrade_parser.set_defaults(func=_cmd_regrade)

    status_parser = sub.add_parser("status", help="查看 run 状态")
    status_parser.add_argument("--config", default=None, help="JSON 覆盖配置路径")
    status_parser.add_argument("--run-id", default=None)
    status_parser.add_argument("--workspace-root", default=None)
    status_parser.set_defaults(func=_cmd_status)

    args = parser.parse_args(argv)
    if getattr(args, "config", None) is None:
        args.config = parser.parse_known_args(argv)[0].config
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
