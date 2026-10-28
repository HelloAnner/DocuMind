"""D11 报告拼装：全部数字来自 analysis 文件，模板只做投影。

自包含 HTML（无 CDN、无脚本），附 report-data.json / metrics.csv /
case-index.csv；报告 revision 独立，不覆盖历史报告。
"""

from __future__ import annotations

import csv
import html
import io
import json
from pathlib import Path
from typing import Any

from .core import RunContext, atomic_write_json, atomic_write_text, utc_iso


def esc(value: Any) -> str:
    return html.escape("" if value is None else str(value))


def table(headers: list[str], rows: list[list[Any]]) -> str:
    head = "".join(f"<th>{esc(h)}</th>" for h in headers)
    body = "".join(
        "<tr>" + "".join(f"<td>{esc(cell)}</td>" for cell in row) + "</tr>" for row in rows
    )
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def pct(value: Any) -> str:
    if value is None:
        return "—"
    return f"{value * 100:.2f}%"


STYLE = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  margin: 0; background: #f5f6f8; color: #1f2329; line-height: 1.7; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 32px 24px 96px; }
header.cover { background: linear-gradient(135deg,#12305c,#1c4f8f); color: #fff; padding: 40px 32px;
  border-radius: 14px; margin-bottom: 28px; }
header.cover h1 { margin: 0 0 8px; font-size: 28px; }
header.cover .meta { opacity: .85; font-size: 13px; }
section { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 22px 24px;
  margin-bottom: 20px; }
h2 { font-size: 20px; margin: 0 0 12px; border-left: 4px solid #1c4f8f; padding-left: 10px; }
h3 { font-size: 16px; margin: 20px 0 8px; }
h4 { font-size: 14px; margin: 16px 0 6px; color: #41464d; }
table { width: 100%; border-collapse: collapse; margin: 10px 0 16px; font-size: 13px; }
th, td { border: 1px solid #e0e3e7; padding: 7px 9px; text-align: left; vertical-align: top; }
th { background: #f1f4f8; font-weight: 600; }
tr:nth-child(even) td { background: #fafbfc; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
.badge.P { background: #e5f6ea; color: #1f7a3d; }
.badge.F { background: #fdeaea; color: #b42318; }
.badge.U { background: #fff4e0; color: #b25e00; }
.badge.E { background: #eef0f3; color: #4b5563; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit,minmax(170px,1fr)); gap: 12px; margin: 12px 0 4px; }
.kpi { background: #f7f9fc; border: 1px solid #e3e8ef; border-radius: 10px; padding: 12px 14px; }
.kpi .label { font-size: 12px; color: #5b6470; }
.kpi .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
.kpi .sub { font-size: 12px; color: #6b7280; }
.note { font-size: 12px; color: #6b7280; }
pre { background: #f6f7f9; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px;
  white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.case { border-top: 1px solid #eceef1; padding-top: 14px; margin-top: 14px; }
details summary { cursor: pointer; font-weight: 600; margin: 6px 0; }
.warn { background: #fff8e6; border: 1px solid #f2d38a; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
.ok { background: #eefaf1; border: 1px solid #9ed8b0; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
"""


def kpi(label: str, value: str, sub: str = "") -> str:
    return f'<div class="kpi"><div class="label">{esc(label)}</div><div class="value">{esc(value)}</div><div class="sub">{esc(sub)}</div></div>'


def render_report(
    ctx: RunContext, *, data: dict[str, Any], revision: str,
) -> dict[str, Any]:
    overall = data["metrics"]["overall"]
    metrics = data["metrics"]
    cases = data["cases"]
    findings = data.get("findings", {})
    manifest = data.get("manifest", {})
    cleanup = data.get("cleanup", {})
    ingestion = metrics["ingestion"]
    run_root = str(ctx.root)

    # ---------------------------------------------------------- 摘要
    gate_ok = cleanup.get("cleanup_status") == "verified"
    summary = [
        f'<section id="summary"><h2>一、摘要与门禁</h2>',
        '<div class="kpis">',
        kpi("整体准确性 P/N", f"{overall['P']}/{overall['N']}", f"95% CI {overall['confidence_interval']}"),
        kpi("整体准确性", pct(overall["value"]), "端到端任务正确率，首次 trial"),
        kpi("F / U / E", f"{overall['F']} / {overall['U']} / {overall['E']}", "失败/未决/系统故障"),
        kpi("已判定率 P/(P+F)", pct(overall["decided_value"]), f"覆盖率 {pct(overall['decision_coverage'])}"),
        kpi("入库事实保留率", pct(ingestion["fact_retention_rate"]), f"{ingestion['facts_retained']}/{ingestion['facts_total']} 条标准事实"),
        kpi("清理核验", "verified" if gate_ok else str(cleanup.get("cleanup_status")), f"残留表 {len(cleanup.get('remaining') or {})}"),
        "</div>",
        '<h3>本次评估范围</h3>',
        f"<p>系统 <b>DocuMind</b>；run_id <b>{esc(ctx.run_id)}</b>；隔离等级 <b>tenant_namespace</b>"
        f"（同一部署内的独立评测租户，非独立实例）。语料为受控合成文档 "
        f"{ingestion.get('files_total')} 个文件，冻结任务 {overall['planned_tasks']} 个，"
        f"实际处理 {overall['processed_tasks']} 个。</p>",
        (f'<div class="ok">清理已核验：数据库逐表计数为 0，Elasticsearch 该租户文档计数为 0。</div>'
         if gate_ok else f'<div class="warn">清理未核验通过：{esc(cleanup.get("cleanup_status"))}；'
                          f'残留 {esc(json.dumps(cleanup.get("remaining") or {}, ensure_ascii=False))}</div>'),
        '<h3>可信等级</h3>',
        '<div class="warn">本报告的语义维度由模型裁判给出，未经过人工校准，属于<b>自动评估估计</b>，'
        '不等于生产环境真实准确率；分母与方法详见各章节与限制。</div>',
        "</section>",
    ]

    # ---------------------------------------------------------- 语料与方法
    corpus_rows = [
        [item["document_ref"], item["file_type"], item["revision"], item["file_sha256"][:12],
         item["source_verification"], len(item.get("fact_ids") or [])]
        for item in data.get("corpus", [])
    ]
    method = [
        '<section id="method"><h2>二、语料与方法</h2>',
        '<h3>受控语料</h3>',
        table(["文档", "格式", "版本", "sha256", "源文件核验", "标准事实数"], corpus_rows),
        '<p class="note">标准事实由程序按制度文本预注册（facts.py），渲染成真实 docx/pdf/pptx/md/txt 后回读核验，'
        '确认源文件确实包含全部必要条件词后才上传。</p>',
        '<h3>执行链路</h3>',
        '<pre>受控语料 → CLI 上传/解析/索引 → 冻结题集 → 真实 chat（单题独立会话）'
        ' → 证据导出（逐阶段候选 + 实际可见上下文）→ CLI 删除资源 → 租户硬清理 + 零残留核验'
        ' → 离线规则核验 + 独立维度裁判 → 盲审/争议对账 → 统计与报告</pre>',
        '<h3>题集审核</h3>',
        (lambda dm: table(["项", "值"], [
            ["候选题数", dm.get("total")],
            ["独立审核通过", (dm.get("validation") or {}).get("valid")],
            ["审核判定无效（不进入正式分母）", (dm.get("validation") or {}).get("invalid")],
            ["审核未决（保留并标注）", (dm.get("validation") or {}).get("unknown")],
            ["被排除题号", ", ".join((dm.get("validation") or {}).get("excluded_case_ids") or []) or "无"],
            ["正式计分题数", dm.get("scored_cases")],
            ["场景分布", json.dumps(dm.get("by_scenario") or {}, ensure_ascii=False)],
            ["难度分布", json.dumps(dm.get("by_difficulty") or {}, ensure_ascii=False)],
        ]))(data.get("dataset_manifest") or {}),
        '<p class="note">审核只看原文标准与目标，不看被测答案；被判定无效的题目不进入正式准确率分母，'
        '但淘汰原因与数量完整保留在 dataset/validation.jsonl。</p>',
        '<h3>版本信息</h3>',
        table(["项", "值"], [
            ["评估代码版本", manifest.get("evaluation_version", "unknown")],
            ["CLI", manifest.get("cli", {}).get("binary", "unknown")],
            ["业务模型", ", ".join(sorted({str(v.get("model")) for v in (manifest.get("models", {}).get("profiles") or {}).values() if isinstance(v, dict)}))],
            ["裁判 prompt 版本", manifest.get("prompt_version", "v1.0")],
            ["配置 hash", str(manifest.get("config_hash", ""))[:16]],
            ["运行目录", run_root],
        ]),
        "</section>",
    ]

    # ---------------------------------------------------------- 整体数字明细
    overall_rows = [
        ["P（通过）", overall["P"], "全部必要检查通过"],
        ["F（失败）", overall["F"], "存在明确关键失败"],
        ["U（未决）", overall["U"], "证据/标准/裁判未决"],
        ["E（系统故障）", overall["E"], "无结果或系统错误"],
        ["N（任务总数）", overall["N"], "首次 trial，一次多轮会话记为一个任务"],
        ["P/N 整体准确性", overall["value"], f"95% CI {overall['confidence_interval']}"],
        ["P/(P+F) 已判定率", overall["decided_value"], f"判定覆盖率 {overall['decision_coverage']}"],
        ["U/N", overall["unknown_rate"], "未决占比"],
        ["E/N", overall["system_error_rate"], "系统故障占比"],
        ["计划/已处理/pending", f"{overall['planned_tasks']}/{overall['processed_tasks']}/{overall['pending_tasks']}", "执行覆盖率 " + pct(overall["execution_coverage"])],
    ]
    overall_section = [
        '<section id="overall"><h2>三、整体准确性与数字明细</h2>',
        table(["口径", "数值", "说明"], overall_rows),
        '<p class="note">主指标名称：整体准确性（端到端任务正确率）。P 要求本题全部必要结果正确：'
        '关键事实、条件/例外/步骤、明确版本规则、预期作答或拒答行为、必要引用与权限。'
        '不把各阶段失败数求和当作整体错题数，阶段指标在四、五节单独列出。</p>',
        '<h3>分层明细（同口径 P/F/U/E）</h3>',
    ]
    for slice_name, rows in metrics["slices"].items():
        overall_section.append(f"<h4>{esc(slice_name)}</h4>")
        overall_section.append(table(
            ["取值", "n", "P", "F", "U", "E", "准确性", "95% CI"],
            [[row["value"], row["n"], row["P"], row["F"], row["U"], row["E"],
              pct(row["accuracy"]), row["confidence_interval"]] for row in rows],
        ))
    overall_section.append("</section>")

    # ---------------------------------------------------------- 阶段与维度
    stage = [
        '<section id="stages"><h2>四、入库、解析与检索</h2>',
        '<h3>入库完成率</h3>',
        table(["计划文件", "可问答文件", "入库完成率"], [
            [ingestion.get("files_total"), ingestion.get("files_indexed"), pct(ingestion.get("ingestion_rate"))],
        ]),
        '<h3>标准事实保留率（解析/切块语义）</h3>',
        table(["标准事实", "正确保留", "缺失", "无法判定", "保留率"], [
            [ingestion.get("facts_total"), ingestion.get("facts_retained"),
             ingestion.get("facts_missing"), ingestion.get("facts_unknown"), pct(ingestion.get("fact_retention_rate"))],
        ]),
        '<h3>逐阶段召回核查（必要条件词匹配）</h3>',
        table(["阶段", "覆盖题目", "集合命中事实", "单候选命中", "必需事实", "Recall@K（集合）", "Recall@K（单候选）"],
              [[name, payload.get("cases"), payload.get("hits"), payload.get("single_hits"),
                payload.get("required"), pct(payload.get("recall")), pct(payload.get("single_recall"))]
               for name, payload in sorted(metrics["retrieval"]["stages"].items())]),
        '<p class="note">这是程序近似：某阶段候选并集包含某标准事实的全部必要条件词才算"集合命中"'
        '（允许跨 chunk 重建）；单候选命中更严格。语义层由相关性裁判另行判断，二者不互相替代。</p>',
        '<h3>引用定位（程序核验）</h3>',
        table(["引用关系数", "quote 可在原文定位", "定位正确率", "精确定位率"], [
            [metrics["citations"]["relations"], metrics["citations"]["quote_in_source"],
             pct(metrics["citations"]["quote_in_source_rate"]), pct(metrics["citations"]["location_rate"])],
        ]),
        "</section>",
    ]

    dimension_labels = {
        "fact_correctness": "事实正确性（对照已确认原文标准）",
        "completeness": "完整性（对照必需事实/条件/例外）",
        "faithfulness": "忠实度（对照模型实际可见上下文）",
        "citation": "引用支持与覆盖",
        "behavior": "行为（作答/拒答/澄清/权限/注入）",
        "dialogue": "多轮（指代/条件继承/纠正）",
        "relevance": "候选相关性与事实支持",
    }
    dim_section = ['<section id="dimensions"><h2>五、独立维度分析</h2>']
    for dimension, payload in sorted(metrics["judges"].items()):
        if dimension not in dimension_labels:
            continue
        dim_section.append(f"<h3>{esc(dimension_labels[dimension])}</h3>")
        dim_section.append(table(
            ["题目判定", "通过", "失败", "未决", "不适用", "题目通过率", "检查项通过率"],
            [[",".join(f"{k}={v}" for k, v in payload["cases"].items()), payload["cases"]["pass"],
              payload["cases"]["fail"], payload["cases"]["unknown"], payload["cases"]["not_applicable"],
              pct(payload["pass_rate"]), pct(payload["check_pass_rate"])]],
        ))
    dim_section.append(
        '<p class="note">事实正确与完整性的分母都是必需事实，两项相关，不能当作彼此独立的证据重复加权；'
        '忠实度只对照实际可见上下文，空答/拒答不给忠实度满分。</p></section>'
    )

    # ---------------------------------------------------------- 案例详情
    case_section = ['<section id="cases"><h2>六、具体案例与证据链</h2>']
    case_section.append(
        '<p class="note">每案例可追到：问题 → 必需事实与原文定位 → 逐阶段检索候选 → 实际可见上下文 → '
        '实际回答与引用定位 → 各维度判定与理由。</p>')
    for record in cases:
        outcome = data["outcome_by_case"].get(record["case_id"], {})
        status = outcome.get("status", "U")
        case_section.append(
            f'<div class="case"><h3>{esc(record["case_id"])} '
            f'<span class="badge {esc(status)}">{esc(status)}</span></h3>'
            f'<p><b>场景</b> {esc(record["scenario"])}｜<b>难度</b> {esc(record["difficulty"])}｜'
            f'<b>可回答性</b> {esc(record["answerability"])}｜<b>预期行为</b> {esc(record["expected_behavior"])}</p>'
            f'<p><b>问题</b> {esc(record["question"])}</p>'
        )
        for turn in record.get("turns") or []:
            context = turn.get("visible_context") or {}
            candidates = ", ".join(
                f"{stage}:{len(items)}" for stage, items in (turn.get("retrieval_stages") or {}).items()
            ) or "无"
            citations = "；".join(
                f"[{citation.get('index')}] {str(citation.get('quote'))[:60]} @{citation.get('document_ref')}"
                f"（定位 {((citation.get('locator') or {}).get('location_status'))}，"
                f"quote命中={'是' if citation.get('quote_in_source') else '否'}）"
                for citation in (turn.get("citations") or [])
            ) or "无引用"
            case_section.append(
                f'<h4>第 {esc(turn.get("turn_index"))} 轮：{esc(turn.get("user_message"))}</h4>'
                f'<p><b>实际回答</b></p><pre>{esc(turn.get("answer"))}</pre>'
                f'<p class="note"><b>逐阶段候选</b> {esc(candidates)}｜'
                f'<b>实际可见上下文</b> {esc(context.get("export_status"))}（{len(context.get("segments") or [])} 段）｜'
                f'<b>返回码</b> {esc(turn.get("returncode"))}</p>'
                f'<p class="note"><b>引用</b> {esc(citations)}</p>'
                f'<p class="note"><b>原始 CLI 输出</b> {esc(turn.get("raw_path"))}｜'
                f'<b>源文件</b> corpus/files/（{esc(",".join(record.get("document_families") or []) or "—")}）</p>'
            )
        case_section.append('<details><summary>标准事实与逐维度判定</summary>')
        case_section.append("<h4>必需标准事实</h4>")
        facts = [fact for fact in (record.get("standard_facts") or [])
                 if fact["fact_id"] in (record.get("required_fact_ids") or [])]
        if facts:
            case_section.append(table(
                ["fact_id", "标准陈述", "文档", "版本", "生效期"],
                [[fact["fact_id"], fact["statement"], fact["document_ref"], fact["revision"],
                  f"{fact.get('effective_from') or '—'}~{fact.get('effective_to') or '今'}"] for fact in facts],
            ))
        else:
            case_section.append('<p class="note">本题不依赖标准事实（行为类）。</p>')
        case_section.append("<h4>逐维度判定</h4>")
        rows = []
        verdict = data.get("verdict_by_case", {}).get(record["case_id"], {})
        for dimension, judgment in (verdict.get("dimensions") or {}).items():
            if not isinstance(judgment, dict) or not judgment.get("checks"):
                continue
            for check in judgment["checks"]:
                rows.append([dimension, check.get("check_id"), check.get("status"),
                             check.get("reason_code"), str(check.get("reason"))[:180]])
        case_section.append(table(["维度", "检查项", "状态", "reason_code", "理由"], rows))
        case_section.append("</details></div>")
    case_section.append("</section>")

    # ---------------------------------------------------------- 结论与限制
    conclusion = ['<section id="conclusion"><h2>七、整体结论与限制</h2>']
    conclusion.append(
        f"<p>本次评估在隔离评测租户内，对 {overall['planned_tasks']} 个冻结任务完成真实 CLI 全链路执行，"
        f"整体准确性为 <b>{overall['P']}/{overall['N']} = {pct(overall['value'])}</b>"
        f"（95% CI {overall['confidence_interval']}），其中 F={overall['F']}、U={overall['U']}、E={overall['E']}。</p>")
    weakest = []
    for dimension, payload in sorted(metrics["judges"].items(), key=lambda item: item[1]["pass_rate"] if item[1]["pass_rate"] is not None else 2):
        if dimension in dimension_labels and payload["cases"]["fail"] + payload["cases"]["unknown"] > 0:
            weakest.append((dimension, payload["pass_rate"]))
    if weakest:
        conclusion.append("<p>相对薄弱维度：" + "、".join(
            f"{dimension_labels.get(name, name)}（通过率 {pct(rate)}）" for name, rate in weakest[:4]) + "。</p>")
    conclusion.append("<h3>关键失败案例</h3>")
    conclusion.append(table(
        ["案例", "场景", "状态", "原因"],
        [[row["case_id"], row["scenario"], row["status"], row["reason"]] for row in
         [item for item in data["outcome_by_case"].values() if item["status"] in ("F", "U", "E")]],
    ) or '<p class="note">本次没有 F/U/E 案例。</p>')
    conclusion.append("<h3>限制与可信边界</h3>")
    conclusion.append(table(
        ["限制", "说明", "证据"],
        [[limitation.get("limitation_id"), limitation.get("text"),
          ", ".join(limitation.get("evidence_refs") or [])] for limitation in findings.get("limitations", [])],
    ))
    conclusion.append(
        '<div class="warn">安全与清理门禁独立于准确性，不被高分抵消；本报告数字全部可由 '
        f'<code>{esc(run_root)}/analysis</code> 下的文件回算。</div>')
    conclusion.append("</section>")

    # ---------------------------------------------------------- 附录
    appendix = [
        '<section id="appendix"><h2>八、附录与证据索引</h2>',
        '<h3>全量任务索引</h3>',
        table(["case_id", "场景", "难度", "总体", "conversation_id"],
              [[row["case_id"], row["scenario"], row["difficulty"], row["status"],
                data["conversation_by_case"].get(row["case_id"]) or "—"]
               for row in data["outcome_by_case"].values()]),
        '<h3>文件索引</h3>',
        table(["文件", "用途"], [
            ["analysis/overall.json", "整体准确性 P/F/U/E 与门禁"],
            ["analysis/metrics.json", "阶段与维度指标、分层"],
            ["analysis/failures.jsonl", "F/U/E 案例清单"],
            ["analysis/findings.json", "已确认结论与限制"],
            ["normalized/cases.jsonl", "每题完整证据链"],
            ["export/evidence-registry.json", "证据注册表（切块/原文段落）"],
            ["grading/verdicts.jsonl", "逐维度判定"],
            ["grading/review-blind.jsonl", "盲审记录"],
            ["cleanup.json", "清理与零残留核验"],
            ["manifest.json", "运行身份、配置与版本"],
        ]),
        "</section>",
    ]

    body = "".join(summary + method + overall_section + stage + dim_section + case_section + conclusion + appendix)
    page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(data.get('title', 'DocuMind 准确性评估报告'))}</title>
<style>{STYLE}</style></head>
<body><div class="wrap">
<header class="cover">
  <h1>{esc(data.get('title', 'DocuMind 文档问答准确性评估报告'))}</h1>
  <div class="meta">
    run_id {esc(ctx.run_id)}｜报告 revision {esc(revision)}｜生成时间 {esc(utc_iso())}｜
    保密级别：内部｜隔离等级 tenant_namespace
  </div>
</header>
{body}
</div></body></html>
"""

    reports_dir = ctx.path("reports", revision)
    reports_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_text(reports_dir / "report.html", page)
    atomic_write_text(ctx.path("reports", "report.html"), page)

    report_data = {
        "run_id": ctx.run_id, "revision": revision, "generated_at": utc_iso(),
        "overall": overall, "metrics": metrics, "findings": findings,
        "outcomes": list(data["outcome_by_case"].values()), "cleanup": cleanup,
    }
    atomic_write_json(reports_dir / "report-data.json", report_data)
    atomic_write_json(ctx.path("reports", "report-data.json"), report_data)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["metric_id", "title", "value", "denominator", "basis"])
    writer.writerow(["overall_accuracy", overall["title"], overall["value"], overall["N"], overall["basis"]])
    writer.writerow(["overall_P", "通过任务数", overall["P"], overall["N"], "rule_verified"])
    writer.writerow(["overall_F", "失败任务数", overall["F"], overall["N"], "judge_estimate"])
    writer.writerow(["overall_U", "未决任务数", overall["U"], overall["N"], "judge_estimate"])
    writer.writerow(["overall_E", "系统故障任务数", overall["E"], overall["N"], "rule_verified"])
    writer.writerow(["ingestion_rate", "入库完成率", ingestion.get("ingestion_rate"), ingestion.get("files_total"), "rule_verified"])
    writer.writerow(["fact_retention_rate", "标准事实保留率", ingestion.get("fact_retention_rate"), ingestion.get("facts_total"), "rule_verified"])
    writer.writerow(["quote_in_source_rate", "引用 quote 定位率", metrics["citations"]["quote_in_source_rate"], metrics["citations"]["relations"], "rule_verified"])
    for dimension, payload in sorted(metrics["judges"].items()):
        writer.writerow([f"dim_{dimension}", dimension_labels.get(dimension, dimension),
                         payload["pass_rate"],
                         payload["cases"]["pass"] + payload["cases"]["fail"] + payload["cases"]["unknown"],
                         "judge_estimate"])
    for stage_name, payload in sorted(metrics["retrieval"]["stages"].items()):
        writer.writerow([f"recall_{stage_name}", f"{stage_name} Recall@K", payload.get("recall"),
                         payload.get("required"), "rule_verified"])
    atomic_write_text(ctx.path("reports", "metrics.csv"), buffer.getvalue())

    index_buffer = io.StringIO()
    index_writer = csv.writer(index_buffer)
    index_writer.writerow(["case_id", "scenario", "difficulty", "answerability", "expected_behavior",
                           "outcome", "failed_dimensions", "conversation_id", "required_fact_ids"])
    for row in data["outcome_by_case"].values():
        index_writer.writerow([row["case_id"], row["scenario"], row["difficulty"], row["answerability"],
                               row["expected_behavior"], row["status"],
                               ",".join(row["failed_dimensions"]),
                               data["conversation_by_case"].get(row["case_id"]) or "",
                               ",".join(row["required_fact_ids"])])
    atomic_write_text(ctx.path("reports", "case-index.csv"), index_buffer.getvalue())

    return {
        "reports_dir": str(reports_dir),
        "html": str(reports_dir / "report.html"),
        "html_bytes": len(page.encode("utf-8")),
        "metrics_csv": str(ctx.path("reports", "metrics.csv")),
        "case_index_csv": str(ctx.path("reports", "case-index.csv")),
    }
