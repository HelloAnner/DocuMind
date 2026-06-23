# Markdown Chunking 详细设计

本文档定义 Markdown 文件在 Text Cleaning 之后如何切分为 chunks。Markdown 具有显式结构标记（标题、列表、代码块、表格等），是四种格式中结构最清晰的一种，切分时应优先保护其原生语义边界。

## 输入

来自 Text Cleaning 的 `cleaned_blocks`，每个 block 的 `block_type` 可能为：

| block_type | 说明 | 是否进入 chunk |
|---|---|---|
| `frontmatter` | YAML/TOML 前置元数据 | 默认不进入检索，仅提取标题/作者 |
| `heading` | `#` ~ `######` 标题 | 作为上下文，不单独成 chunk |
| `paragraph` | 普通正文段落 | 是 |
| `list_item` | 有序/无序列表项 | 是 |
| `code_block` | 围栏代码块 | 是，保持原子性 |
| `table` | Markdown 表格 | 是，按表格策略切分 |
| `blockquote` | 引用块 | 是，保持引用边界 |
| `horizontal_rule` | 分隔线 | 作为硬边界 |
| `image_placeholder` | 图片占位 | 默认不进入检索 |
| `html_block` | 原始 HTML 块 | 按文本内容处理，通常不跨 HTML 边界 |

## 预处理

### Frontmatter 处理

```markdown
---
title: 2025 年度销售策略
author: 张三
---
```

- `title` 写入 `documents.title`；若文档无其他 H1，可把 `title` 作为默认 H1 加入 `heading_path`。
- 其余字段进入 `documents.metadata` 或 `document_parse_results.parsed_json`。
- `frontmatter` block 默认不生成 chunk；配置 `index_frontmatter = true` 时可生成 `source_type = metadata` 的 chunk。

### 标题栈维护

- `#` 数量 = heading_level。
- 标题文本去除 `#` 和尾标点后压入标题栈。
- 新标题 level ≤ 当前 level 时，弹出同级及更深层级标题。
- 标题 block 不直接生成 chunk，只更新后续 block 的 `heading_path`。

### 链接与图片

- Markdown 链接 `[文本](url)` 保留文本部分，URL 在 content 中可省略或放在 metadata。
- 图片 `![alt](url)` 只保留 alt 文本，作为 `image_placeholder` block 处理。
- 自动链接 `<https://...>` 保留 URL 文本。

## 硬边界规则

以下情况必须结束当前 chunk 候选组：

1. **H1 标题**：遇到 `# ` 时，当前组必须结束，新组从 H1 后的第一个内容 block 开始。
2. **代码块开始/结束**：围栏代码块 ` ``` ` 作为独立原子块，不与其他类型混排。
3. **表格开始/结束**：Markdown 表格 block 单独成 table chunk。
4. **水平分隔线**：`---` / `***` / `___` 视为章节分隔，强制结束当前组。
5. **frontmatter 边界**：frontmatter 前后均结束当前组。
6. **blockquote 边界**：blockqutoe 段落与普通段落之间不合并（保持引用语义）。

## 软边界规则

以下情况允许合并到同一 chunk：

- 同一段落内的多个短句。
- 同一 H2 / H3 下的多个 `paragraph` block。
- 连续 `list_item`，包括有序列表和无序列表。
- 标题与其后的第一段正文。
- 同一 blockquote 内的多个段落。

## 列表处理

### 列表项合并

连续 `list_item` 优先合并为一个 chunk：

```markdown
- 华东区目标 1200 万
- 华南区目标 900 万
- 华北区目标 800 万
```

生成 chunk content：

```text
标题路径：年度策略 / 区域目标

- 华东区目标 1200 万
- 华南区目标 900 万
- 华北区目标 800 万
```

### 嵌套列表

嵌套列表保留缩进层级，子列表不单独拆出，除非整体 token 超过 `max_chunk_tokens`：

```markdown
- 华东区
  - 上海：500 万
  - 杭州：300 万
- 华南区
  - 广州：400 万
```

### 超长列表拆分

当列表整体 token 超过 `max_chunk_tokens` 时，按 item 边界拆分：

- 优先在顶层 item 处拆分，不要把子项从父项中割裂。
- 每个拆分后的 chunk 保留前一块的最后 1~2 个 item 作为 overlap。

## 代码块处理

### 原子性

围栏代码块默认作为原子 block，不与其他段落合并。

```markdown
```python
def calc(x):
    return x * 2
```
```

### 超长代码块切分

当代码块 token 数超过 `max_chunk_tokens` 时：

1. 按行边界拆分。
2. 每行独立 token 若仍超过上限，按语义 token 边界（函数/类/逻辑块）拆分。
3. 每个代码 chunk 保留语言标识：

```text
代码：python（片段 1/3）

def calc(x):
    return x * 2
```

### 代码块 Overlap

代码块内部切分时，在 chunk 边界保留前后 2~3 行代码作为上下文；跨代码块与普通段落之间不追加 overlap。

## 表格处理

Markdown 表格解析为结构化 `document_tables` 后，按通用表格策略生成 table chunk。

### 小表格

```markdown
| 区域 | 目标 | 负责人 |
|---|---|---|
| 华东 | 1200 万 | 张三 |
| 华南 | 900 万 | 李四 |
```

生成一个 `source_type = table` 的 chunk，content 中保留 Markdown 表格渲染。

### 中等表格

按行窗口切分，每个 chunk 都带表头和标题路径：

```text
标题路径：年度策略 / 区域目标
表格：区域销售目标（行 1-50）

| 区域 | 目标 | 负责人 |
|---|---|---|
| 华东 | 1200 万 | 张三 |
...
```

### 超大表格

- 生成一个表格摘要 chunk：表名、列含义、行数、关键统计。
- 行级数据不进入向量索引；回答时通过 `table_id` 回表查询。

## Blockquote 处理

- blockquote 内连续段落合并为一个 chunk。
- blockquote 与普通段落之间不合并。
- blockquote 过长时按段落边界拆分，并保留引用标记 `>`。

## HTML Block 处理

- 简单 HTML（如 `<div>`、`<center>`）若只包裹文本，按文本段落处理。
- 复杂 HTML（如 `<table>`、`<script>`、`<style>`）作为独立 block，不进入默认检索；`script`/`style` 直接丢弃。

## 切分示例

### 输入 Markdown

```markdown
# 年度策略

## Q1 目标

华东区 Q1 销售目标为 1200 万元。重点客户包括 A、B、C。

华南区 Q1 销售目标为 900 万元。

## Q2 目标

| 区域 | 目标 |
|---|---|
| 华东 | 1300 万 |
| 华南 | 1000 万 |

Q2 重点关注客户留存。
```

### 输出 Chunks

| chunk_index | source_type | heading_path | content 概要 |
|---|---|---|---|
| 0 | paragraph | [年度策略, Q1 目标] | 华东区 + 华南区目标 |
| 1 | table | [年度策略, Q2 目标] | 区域目标表 |
| 2 | paragraph | [年度策略, Q2 目标] | Q2 重点关注客户留存 |

## 元数据补充

Markdown chunk 的 `metadata` 建议包含：

```json
{
  "format": "markdown",
  "heading_levels": [1, 2],
  "list_depth": 0,
  "code_language": null,
  "table_row_range": null
}
```

## 常见边界问题

| 问题 | 处理 |
|---|---|
| H1 后直接跟表格 | 表格单独成 chunk，标题路径包含 H1 |
| 列表中间插入代码块 | 列表 chunk 结束，代码块单独成 chunk |
| 表格后立即是 H2 | H2 作为新 chunk 的标题路径 |
| 空段落 / 仅换行 | 清洗阶段已过滤，不再进入 chunk |
| 行内公式 `$...$` | 保留原文，不做切分点 |
| 块级公式 `$$...$$` | 视为独立 block，按代码块类似处理 |

## 配置参数覆盖

Markdown 可在 `chunker_config.markdown` 中覆盖以下参数：

```json
{
  "markdown": {
    "index_frontmatter": false,
    "keep_code_language_tag": true,
    "list_merge_max_items": 100,
    "blockquote_merge_paragraphs": true
  }
}
```
