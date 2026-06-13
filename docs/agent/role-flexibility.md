# 角色灵活度 (Role Flexibility)

Agent 的灵活度来自“角色模式”而不是自由发挥。不同用户问题需要不同工作方式：有时是检索员，有时是解释者，有时是分析师，有时是审阅伙伴。角色可以切换，但证据边界不变。

## 角色模式

| 模式 | 触发场景 | 主要输出 |
|---|---|---|
| `answerer` 直接回答者 | 用户问明确事实 | 结论 + 引用 |
| `clarifier` 澄清者 | 指代不明、范围不明 | 一个简短澄清问题 |
| `summarizer` 总结者 | “总结一下”“这份文档讲什么” | 分层摘要 + 关键引用 |
| `comparer` 对比者 | “A 和 B 有什么区别” | 对比维度 + 差异表 |
| `analyst` 分析者 | “是否合理”“风险是什么” | 基于文档的分析框架 |
| `navigator` 导航者 | “在哪一页”“哪里提到了” | 文档位置 + 原文摘录 |
| `reviewer` 审阅者 | “帮我检查有没有遗漏” | 检查清单 + 已发现证据 |

## 模式选择

```text
用户问题
  │
  ├── 指代不明 / 范围不明 -> clarifier
  ├── 明确问事实 -> answerer
  ├── 要摘要 -> summarizer
  ├── 要比较 -> comparer
  ├── 要判断 / 风险 / 建议 -> analyst
  ├── 要出处 / 页码 -> navigator
  └── 要检查完整性 -> reviewer
```

## 模式切换示例

用户：

```text
这份合同付款节点是什么？
```

Agent 使用 `answerer`：

```text
这份合同能确认两个付款节点：[1] 首付款在合同签署后支付；[2] 验收通过后支付尾款。当前片段没有明确质保金条款。
```

用户追问：

```text
和供应商 B 的合同比呢？
```

Agent 切换为 `comparer`：

```text
我会按付款节点、比例、触发条件三个维度对比两份合同。当前问题里的“供应商 B 的合同”需要确认是哪一份：是《B公司采购合同》还是《B公司框架协议》？
```

## 灵活但不漂移

角色切换不能改变任务边界。

| 可以做 | 不可以做 |
|---|---|
| 基于文档总结风险点 | 推断法律责任结论 |
| 对比两份制度差异 | 判断哪个制度“更好”但不给依据 |
| 用更容易懂的话解释条款 | 改写成文档没有表达过的承诺 |
| 建议下一步查看哪些材料 | 编造不存在的补充材料 |

## 租户可配置

不同企业可以调整 Agent 的默认气质和模式偏好：

```yaml
agent:
  default_tone: concise_warm
  proactive_followup: true
  max_followup_suggestions: 2
  allow_analyst_mode: true
  require_citation_for_analysis: true
  clarification_style: short
```

## 角色模式记录

每条 assistant message 保存本轮模式，便于评估：

```json
{
  "message_id": "msg_001",
  "agent_mode": "comparer",
  "mode_reason": "user asked to compare current contract with supplier B",
  "requires_citation": true
}
```
