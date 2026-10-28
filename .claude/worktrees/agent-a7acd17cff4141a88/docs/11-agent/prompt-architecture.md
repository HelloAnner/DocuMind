# Prompt 架构

DocuMind Prompt 不再承担固定流水线控制器，也不要求模型输出自定义 JSON action。Prompt 只描述身份、语义边界和工具选择原则；实际工具协议由模型 API 的 JSON Schema 与 Kernel 运行时共同保证。

## 模块

```text
identity
+ conversation
+ tool_policy
+ grounding
+ response
+ security
```

| 模块 | 责任 |
|---|---|
| identity | DocuMind 的企业知识伙伴身份与表达原则 |
| conversation | 当前消息优先、多轮指代和新话题边界 |
| tool_policy | 何时直答、检索或澄清 |
| grounding | 企业事实、证据、引用和不确定性规则 |
| response | answerer/summarizer/comparer/analyst/navigator/reviewer 输出语义 |
| security | 权限、提示注入、证据不可执行 |

对应实现位于 `apps/api-rs/src/agent/prompt/`，由 `BuiltinPromptRegistry` 组合。

## 核心语义

### 当前消息优先

- 当前用户消息是本轮唯一主任务。
- 历史可补全明确的指代、省略和简称。
- 完整的新问题、问候或新话题不得被改写成上一轮问题。
- 历史回答不是企业事实证据；需要文档事实时必须重新检索。

### 工具可选

- 问候、确认、闲聊、写作或普通帮助直接回答。
- 企业文档、合同、制度、记录中的事实调用 `knowledge_search`。
- 只有真实歧义调用 `ask_clarification`。
- 工具失败后改变查询或说明限制，不重复完全相同的调用。
- 工具之外不虚构已执行的能力。

### 自适应 grounding

- 无文档工具的普通回答不强制引用。
- 使用文档证据后，关键企业事实必须用 `[n]` 指向本轮 runtime evidence。
- HyDE、历史回答和模型常识都不是文档证据。
- 证据不足时明确说明边界，不补齐文档没有写的数字、日期、责任人或条款。

### 输出

最终回答是普通 Markdown assistant content，不是 JSON。response mode 是表达语义，不是硬编码流水线：

- `answerer`：直接结论；
- `summarizer`：忠实压缩；
- `comparer`：相同维度对比；
- `analyst`：事实、保守推断和证据边界；
- `navigator`：文档/章节定位；
- `reviewer`：按重要性列问题。

## Prompt 与运行时的分工

| 约束 | Prompt | Runtime |
|---|---:|---:|
| 工具是否有语义必要 | 是 | 观察并审计 |
| 工具存在和参数结构 | 提示 | 强制 |
| 最大 ReAct 步数 | 否 | 强制 |
| 重复 tool call | 提示 | 强制拒绝 |
| analyst 开关 | 提示 | 强制拒绝 |
| KB 权限范围 | 不可修改 | 强制 |
| 引用 ID 有效性 | 提示 | 强制校验 |
| 检索无结果分类 | 提示 | 强制 low/no-answer |

这使 Prompt 可以演进，而安全和功能不依赖某段措辞恰好被模型遵守。

## 版本

```yaml
persona: persona-v4
guardrail: adaptive-grounding-v20
mode: semantic-mode-autonomous-v20
task: native-tool-react-v20
```

每条 Agent Trace 保存四个版本。修改任何会影响工具选择、grounding 或输出语义的模块时必须升级对应版本，并使缓存指纹失效。
