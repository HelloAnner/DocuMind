# Agent 评估体系 (Evaluation)

Agent 的评估不能只看答案是否命中文档，还要看它是否理解了真实问题、是否有合适的角色模式、是否表达自然、有温度，并且没有越过可信边界。

## 评估维度

| 维度 | 问题 |
|---|---|
| 问题保真 | 是否回答了用户真实问题，而不是系统改写出来的另一个问题 |
| 证据可信 | 关键结论是否都有引用支撑 |
| 角色合适 | 是否选择了正确模式：回答、澄清、总结、对比、分析 |
| 表达温度 | 是否简洁、专业、尊重用户困惑 |
| 推进能力 | 是否给了可执行的下一步 |
| 边界感 | 是否避免了无依据结论和高风险裁决 |

## 自动指标

```yaml
agent.metrics:
  citation_coverage_rate: 关键结论被引用覆盖的比例
  no_source_claim_rate: 无引用支撑结论比例
  clarification_precision: 澄清是否真的必要
  rewrite_drift_rate: 改写偏离原问题比例
  negative_feedback_rate: 负反馈比例
  wrong_intent_feedback_rate: 答非所问反馈比例
  mode_selection_accuracy: 角色模式选择准确率
```

## 人工标注 Rubric

每条样本按 1-5 分标注：

| 分数 | 标准 |
|---|---|
| 5 | 准确、有引用、有温度，主动补足下一步 |
| 4 | 准确可信，表达清楚，但推进感一般 |
| 3 | 大体可用，但有轻微信息缺口或表达机械 |
| 2 | 有明显答非所问、引用不足或模式错误 |
| 1 | 幻觉、越权、错误结论或严重误导 |

## 真实问题集

评估集优先来自真实用户问题的脱敏样本，而不是模型生成问题。

```json
{
  "question": "那它付款节点是什么？",
  "history": [
    {
      "role": "assistant",
      "content": "上一轮引用了《Q3采购合同》。"
    }
  ],
  "expected_mode": "answerer",
  "expected_rewrite": "Q3采购合同的付款节点是什么？",
  "expected_citations": ["chunk_003"],
  "golden_answer": "合同签署后支付首付款，验收通过后支付尾款。"
}
```

## 温度评估

温度不是“多说好听话”，而是减少用户负担。

可标注项：

- 是否先给结论
- 是否说明不能确认的部分
- 是否给出下一步
- 是否避免责备用户表达不清
- 是否避免过度热情和空泛话术

## 回归测试场景

- 指代不明必须澄清
- 证据不足必须拒答
- 多版本冲突必须列冲突
- 比较问题必须覆盖所有对象
- 风险判断必须区分事实和推断
- 用户负反馈 correction 应进入评估样本池

## 自动评估落地

当前仓库提供一套可直接打远端服务器的 golden evaluation：

- 数据集：`tests/golden/documind_core.json`
- 执行脚本：`scripts/eval-golden.py`
- 默认目标：`BASE_URL=http://123.57.255.204:8089`

数据集包含 5 份动态生成 fixture，覆盖 DOCX / PDF / PPTX / Markdown / TXT；每种格式 10 条问题，共 50 条。脚本每次运行都会生成唯一 run marker，写入文档内容与问题，避免命中服务器历史同名测试文档。

运行命令：

```bash
BASE_URL=http://123.57.255.204:8089 scripts/eval-golden.py \
  --output /tmp/documind-golden-report.json
```

快速 smoke：

```bash
BASE_URL=http://123.57.255.204:8089 scripts/eval-golden.py \
  --limit 3 \
  --output /tmp/documind-golden-smoke.json
```

Office Preview 与 OCR smoke：

```bash
BASE_URL=http://123.57.255.204:8089 scripts/api-test-preview-ocr.py
```

浏览器 FileView smoke：

```bash
BASE_URL=http://123.57.255.204:8089 scripts/browser-test-fileview.sh
```

运维 metrics smoke：

```bash
BASE_URL=http://123.57.255.204:8089 scripts/api-test-metrics.sh
```

发布门禁：

```bash
BASE_URL=http://123.57.255.204:8089 make release-gate
```

`make release-gate` 会串行执行服务器 health、metrics smoke、核心 API smoke、golden smoke、Office/OCR/preview-token smoke 和浏览器 FileView smoke。默认 golden 只跑 3 条快速样本；可用 `GOLDEN_LIMIT=50` 做完整回归，也可用 `RUN_BROWSER=0`、`RUN_PREVIEW_OCR=0` 等环境变量临时跳过较重步骤。

该脚本会真实打远端服务器：

1. 动态生成 DOCX / PPTX，上传并等待 `indexed`。
2. 调用 `/api/files/{doc_id}/preview/manifest`，验证 `preview_type=office_pdf`、`conversion_status=converted`、`page_count >= 1`。
3. 调用 `/api/files/{doc_id}/preview/content` 与 `/api/files/{doc_id}/preview/pages/1/pdf`，验证返回 PDF bytes。
4. 调用 `/api/files/{doc_id}/preview-url`，验证带 `preview_token` 的短期 manifest/content/page PDF URL 可在不带 Authorization header 时访问。
5. 动态生成 image-only scanned PDF，上传后验证初始状态为 `parse_low_confidence`。
6. 调用 `/api/admin/documents/{doc_id}/send-to-ocr`，等待 OCR 后进入 `indexed`。
7. 查询 PostgreSQL，验证 OCR chunk、marker 文本和 bbox anchor 已落库。
8. 通过 SSE 对 OCR 文档提问，验证答案包含 OCR 文本，并返回带 anchor 的 citation。

浏览器 FileView 脚本会复用最近一份已完成 OCR 的 smoke 文档，先通过 API 准备一轮带 citation 的会话，再用 agent-browser 打开远端 `/documind/chat?c=...`，点击 citation 并断言：

1. 右侧 FileView 出现 `精确定位` 状态。
2. 页面包含 `已按原文锚点定位并高亮` 文案。
3. PDF canvas 已渲染。
4. `.dm-pdf-anchor-overlay` 存在并包含高亮子节点。
5. 目标 PDF 页同时处于 `is-target` 与 `is-ready` 状态。
6. 截图保存到 `/tmp/documind-fileview-ocr.png`。

评估流程：

1. 使用本地账号登录远端服务器。
2. 动态生成 5 份 fixture 并上传到当前用户可访问知识库。
3. 等待所有 fixture 文档进入 `indexed`。
4. 为每条 golden case 创建独立会话并通过 SSE 提问。
5. 读取 answer、citation、trace、message 持久化结果。
6. 输出 JSON 报告，包含逐条结果与汇总指标。

当前自动指标：

| 指标 | 含义 |
|---|---|
| `overall_pass_rate` | 逐条 case 综合通过率 |
| `citation_coverage_rate` | 非拒答样本是否返回 citation |
| `target_doc_hit_rate` | citation 或 retrieval trace 是否命中本轮上传的目标文档 |
| `no_answer_accuracy` | 证据不足样本是否被识别为不能确认 |
| `mode_selection_accuracy` | Agent mode 是否符合 golden 期望 |

当前 baseline gate：

| Gate | 阈值 |
|---|---:|
| `overall_pass_rate` | `>= 0.82` |
| `citation_coverage_rate` | `>= 0.86` |
| `target_doc_hit_rate` | `>= 0.82` |
| `no_answer_accuracy` | `>= 0.80` |

2026-06-28 在 `http://123.57.255.204:8089` 的一次完整运行结果：

```json
{
  "total": 50,
  "passed": 43,
  "failed": 7,
  "overall_pass_rate": 0.86,
  "citation_coverage_rate": 1.0,
  "target_doc_hit_rate": 1.0,
  "no_answer_accuracy": 1.0,
  "mode_selection_accuracy": 0.88
}
```

这说明 golden pipeline 已经可作为发布前回归门禁使用；剩余失败主要暴露在 mode selection 上，例如部分事实问答被路由到 analyst / reviewer。后续优化 Agent Router 时，应以报告中的 failed cases 做回归样本。

2026-06-28 新增的 preview/OCR smoke 已在远端通过：

- DOCX preview manifest 转换为 `office_pdf`，content 和 page endpoint 均返回 PDF。
- PPTX preview manifest 转换为 `office_pdf`，content 和 page endpoint 均返回 PDF。
- DOCX/PPTX 短期 preview-token URL 可在不带 Authorization header 时访问 manifest、content 和 page PDF。
- 扫描 PDF 经 OCR 后进入 `indexed`，PostgreSQL 中存在 OCR chunk、marker 文本和 bbox anchor。
- OCR 文档问答返回预期验证码/城市，并带 citation anchor。
- 浏览器 FileView smoke 已通过：点击 citation 后右侧 PDF 预览渲染 canvas、bbox overlay 和精确定位状态，并生成 `/tmp/documind-fileview-ocr.png` 截图。
- `/api/metrics` smoke 已通过：Prometheus 文本中包含依赖 up/down、文档状态、chunk、parse job、会话、消息和反馈指标。
- `make release-gate` 已作为统一发布门禁入口，覆盖上述关键 smoke。

## 迭代闭环

```text
真实问题 / 负反馈
  │
  ▼
人工标注
  │
  ▼
Prompt / 策略 / 检索参数调整
  │
  ▼
离线评测
  │
  ▼
灰度上线
  │
  ▼
线上指标监控
```
