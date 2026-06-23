# Markdown Text Cleaning 详细设计

本文档定义 Markdown 文件解析后的 `document_blocks` 如何被清洗为 `cleaned_blocks`，为下游 Chunking 提供规范化、低噪声、结构完整的文本输入。

## 定位与目标

Markdown Text Cleaning 是 Ingest Pipeline 的第二阶段，位于 Document Parsing 之后、Chunking 之前。

### 核心目标

- **保留结构**：标题、列表、代码块、表格、引用等 Markdown 语义标记必须完整保留。
- **去除噪声**：删除控制字符、零宽字符、多余空白、HTML 注释等不影响语义的字符。
- **规范化表达**：统一换行、空格、缩进，统一列表标记风格，统一链接/图片表示。
- **可追溯**：原始 `text` 不被覆盖，清洗操作记录到 `cleaning_ops`。
- **不破坏语义**：代码块、数学公式、表格单元格内容原样保留。

## 输入

来自 Document Parsing 的 `document_blocks`，Markdown 相关 `block_type`：

| block_type | 来源 | 清洗重点 |
|---|---|---|
| `frontmatter` | YAML / TOML / JSON 前置元数据 | 解析为元数据，正文删除 |
| `heading` | `#` ~ `######` | 保留 `#` 与文本，清洗文本部分 |
| `paragraph` | 普通正文段落 | 合并硬换行、规范化空白 |
| `list_item` | `-` / `*` / `+` / `1.` 等 | 保留标记，清洗文本 |
| `code_block` | 围栏代码块 / 缩进代码块 | 保留内部原样，仅清理边界空白 |
| `table` | Markdown 表格 | 规范化 pipe 与单元格空白 |
| `blockquote` | `>` 引用块 | 保留 `>` 标记，清洗文本 |
| `horizontal_rule` | `---` / `***` / `___` | 标准化为 `---` |
| `image_placeholder` | `![alt](url)` | 提取 alt 文本，URL 进 metadata |
| `html_block` | 原始 HTML 块 | 按策略提取文本或保留原样 |
| `math_block` | `$$...$$` / 行内 `$...$` | 保留原样 |
| `comment` | `<!-- ... -->` | 默认删除 |

## 输出

### 输出形式 1：原地更新 `normalized_text`

若项目采用单表 `document_blocks`，Text Cleaning 直接更新 `normalized_text` 字段：

```json
{
  "block_id": "uuid",
  "block_type": "paragraph",
  "text": "华东区 Q1 销售目标为 1200 万元。  ",
  "normalized_text": "华东区 Q1 销售目标为 1200 万元。",
  "heading_path": ["年度策略", "Q1 目标"],
  "cleaning_ops": ["normalize_space", "trim"],
  "is_removed": false
}
```

### 输出形式 2：独立 `cleaned_blocks` 表

若项目采用清洗审计表，则每条清洗记录：

```json
{
  "clean_block_id": "uuid",
  "block_id": "uuid",
  "cleaned_text": "华东区 Q1 销售目标为 1200 万元。",
  "is_removed": false,
  "remove_reason": null,
  "cleaning_ops": ["normalize_space", "trim"]
}
```

两种形式都保留原始 `text`，便于重新清洗和审计。

## 通用清洗规则

所有 block 在类型-specific 清洗前，先执行以下通用规则：

### 1. 去除 BOM

删除 UTF-8 BOM（`\xEF\xBB\xBF`）。

### 2. 统一换行符

将 `\r\n`、`\r` 统一为 `\n`。

### 3. 规范化空白字符

- 将所有制表符 `\t` 替换为空格（默认 4 个空格，可配置）。
- 将全角空格 `\u3000`、不间断空格 `\u00A0`、零宽空格等统一为普通半角空格 `\u0020`。
- 将多个连续空格合并为 1 个，但代码块内部除外。
- 删除行尾空格。
- 保留段落间空行（`\n\n`）作为段落边界。

### 4. 去除控制字符与零宽字符

删除以下字符：

| 字符 | Unicode | 说明 |
|---|---|---|
| 零宽空格 | `\u200B` | 常见于复制粘贴 |
| 零宽非连接符 | `\u200C` | |
| 零宽连接符 | `\u200D` | |
| 左至右标记 | `\u200E` | |
| 右至左标记 | `\u200F` | |
| 零宽不中断空格 | `\uFEFF` | |
| 对象替换字符 | `\uFFFC` | |
| 除 `\n` / `\t` 外的 C0 控制字符 | `\u0000` ~ `\u001F` | |

代码块与数学公式内部也执行此规则，但保留语义可见字符（如 `\t` 已转为空格）。

### 5. Unicode 规范化

使用 NFC 规范化，避免同一字符的不同表示形式影响检索。

### 6. 去除连续空行

段落 block 中，三个及以上连续换行压缩为两个换行（即保留一个空段落间隔）。

## 分类型清洗规则

### Frontmatter

```markdown
---
title: 2025 年度销售策略
author: 张三
---
```

- 解析 YAML / TOML / JSON，提取 `title`、`author`、`date`、`tags` 等字段。
- `title` 写入 `documents.title`；若文档无 H1，可作为默认 H1 候选。
- 其余字段进入 `documents.metadata` 或 `document_parse_results.parsed_json`。
- `frontmatter` block 的 `normalized_text` 为空或保留原始 YAML 字符串（用于调试）。
- 默认不进入检索；配置 `index_frontmatter = true` 时生成 metadata chunk。

### Heading

```markdown
# 年度策略
###  Q1 目标  
```

- 保留 `#` 数量，用于确定 `heading_level`。
- 清洗 `#` 后文本：trim 首尾空格、合并中间多余空格。
- 删除标题末尾的标点（可选，默认保留）。
- 确保标题文本非空；空标题标记为 `is_removed = true`。

示例：

| 原始 | 清洗后 |
|---|---|
| `# 年度策略` | `# 年度策略` |
| `###  Q1 目标  ` | `### Q1 目标` |

### Paragraph

- 合并段落内硬换行：单个 `\n` 替换为空格，保留 `\n\n` 作为段落边界。
- 去除行首行尾空格。
- 合并多个连续空格为 1 个。
- 段落只包含空白或标点时，标记为 `is_removed = true`。

### List Item

```markdown
-  华东区目标 1200 万  
* 华南区目标 900 万
1.  华北区目标
```

- 保留列表标记（`-`、`*`、`+`、`1.`、`(a)` 等）。
- 将制表符缩进替换为 2 或 4 个空格（配置 `list_indent_spaces`）。
- 清洗 item 文本部分：trim、合并多余空格。
- 统一无序列表标记风格（可选，默认保留原始）。
- 嵌套列表按缩进保留层级。

### Code Block

围栏代码块：

````markdown
```python
def calc(x):
    return x * 2
```
````

缩进代码块：

```markdown
    def calc(x):
        return x * 2
```

- **代码块内部视为神圣区**：不合并空格、不换行折叠、不去除控制字符。
- 仅做边界清理：
  - 删除围栏代码块开头/结尾的空行。
  - 保持语言标识（如 `python`）不变，trim 前后空格。
  - 保留内部缩进。
- 行内代码 `` `code` `` 保留反引号。

### Table

```markdown
| 区域 | 目标 | 负责人 |
|---|---|---|
| 华东 | 1200 万 | 张三 |
```

- 规范化 pipe 两侧空格：` | ` -> `|`（保留可读性空格可配置，默认保留 1 个空格）。
- 去除单元格首尾空格。
- 合并单元格内连续空格为 1 个。
- 确保表头分隔行（`| --- |`）存在且格式正确。
- 若表格行 pipe 数量不一致，记录 `cleaning_ops` 警告，不强行修复结构。
- 表格内容不跨行合并。

### Blockquote

```markdown
> 华东区目标 1200 万
>
> 华南区目标 900 万
```

- 保留 `>` 标记。
- 清洗 `>` 后文本部分。
- 嵌套引用保留多级 `>`。
- 空引用行（仅 `>`）可保留或删除，取决于配置。

### Horizontal Rule

- 统一为 `---`。
- 删除周围多余空行。

### Image Placeholder

```markdown
![销售趋势图](assets/chart.png)
```

- 提取 `alt` 文本作为 `normalized_text`。
- URL 进入 `metadata.image_url`。
- 若 `alt` 为空，使用图片文件名作为 fallback。
- 默认不进入检索；下游 Chunking 生成 `image_placeholder` block，可接 OCR / caption。

### HTML Block

- 简单 HTML（`<div>`、`<span>`、`<center>` 等只包裹文本）：提取纯文本内容，按普通段落处理。
- 复杂 HTML（`<table>`、`<script>`、`<style>`、`<iframe>`）：
  - `<script>` / `<style>`：直接丢弃，标记 `is_removed = true`，`remove_reason = unsafe_html`。
  - `<table>`：保留原 HTML 或提取为 Markdown 表格（可配置），生成 `html_block` 或 `table` block。
  - 其他复杂 HTML：保留原始字符串，生成 `html_block`，默认不进入检索。

### Math Block / 行内公式

- `$$...$$` 与 `$...$` 保留原样。
- 仅 trim 外部空白，不修改内部 LaTeX。

### Comment

```markdown
<!-- 这是一条注释 -->
```

- 默认直接删除，标记 `is_removed = true`，`remove_reason = comment`。
- 配置 `keep_comments = true` 时保留为 `comment` block，默认不进入检索。

## 链接处理

```markdown
[销售策略](docs/strategy.md)
<https://example.com>
```

### 默认策略

- 保留链接文本 `[销售策略]` 中的“销售策略”。
- URL 不进入 `normalized_text`，存入 `metadata.link_url`。
- 自动链接 `<https://example.com>` 保留 URL 文本 `https://example.com`。

### 可配置策略

| 配置 | 效果 |
|---|---|
| `link_keep_url = false`（默认） | 只保留链接文本 |
| `link_keep_url = true` | 保留文本 + URL，格式为 `销售策略 (https://...)` |

## 空块与噪声过滤

以下 block 标记为 `is_removed = true`：

- 仅包含空白字符的 paragraph / list_item / heading。
- 仅包含水平线或装饰字符的行（如 `======`、`------`）。
- HTML 注释（默认）。
- `<script>` / `<style>` 块。
- 重复的空 frontmatter（无有效字段）。
- 图片占位 alt 为空且 URL 无效。

## 清洗流水线伪代码

```rust
fn clean_markdown(blocks: Vec<DocumentBlock>, cfg: CleanConfig) -> Vec<CleanedBlock> {
    let mut out = vec![];

    for b in blocks {
        let mut ops = vec![];
        let mut text = b.text.clone();

        // 通用清洗
        text = remove_bom(text, &mut ops);
        text = normalize_line_endings(text, &mut ops);
        text = normalize_whitespace(text, &mut ops);
        text = remove_control_and_zero_width(text, &mut ops);
        text = unicode_nfc(text, &mut ops);

        // 类型-specific 清洗
        let cleaned = match b.block_type {
            "frontmatter" => clean_frontmatter(text, &mut ops, cfg),
            "heading" => clean_heading(text, &mut ops),
            "paragraph" => clean_paragraph(text, &mut ops),
            "list_item" => clean_list_item(text, &mut ops, cfg),
            "code_block" => clean_code_block(text, &mut ops),
            "table" => clean_table(text, &mut ops),
            "blockquote" => clean_blockquote(text, &mut ops),
            "horizontal_rule" => clean_horizontal_rule(text, &mut ops),
            "image_placeholder" => clean_image(text, &mut ops, cfg),
            "html_block" => clean_html_block(text, &mut ops, cfg),
            "math_block" => clean_math(text, &mut ops),
            "comment" => clean_comment(text, &mut ops, cfg),
            _ => text,
        };

        let is_removed = should_remove(&cleaned, &b.block_type, cfg);
        let remove_reason = if is_removed { Some("empty_or_noise".into()) } else { None };

        out.push(CleanedBlock {
            block_id: b.block_id,
            cleaned_text: cleaned,
            is_removed,
            remove_reason,
            cleaning_ops: ops,
        });
    }

    out
}
```

## 配置参数

Markdown Text Cleaning 在 `cleaner_config.markdown` 中可覆盖：

```json
{
  "markdown": {
    "tab_to_spaces": 4,
    "list_indent_spaces": 4,
    "normalize_unordered_list_marker": null,
    "keep_comments": false,
    "keep_html_raw": false,
    "extract_html_table": true,
    "link_keep_url": false,
    "image_alt_fallback_to_filename": true,
    "remove_empty_blocks": true,
    "collapse_empty_lines": true,
    "unicode_normalize": "NFC"
  }
}
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `tab_to_spaces` | 4 | 制表符转空格数 |
| `list_indent_spaces` | 4 | 列表缩进空格数 |
| `normalize_unordered_list_marker` | null | 统一为 `-` / `*` / `+`，null 表示保留原样 |
| `keep_comments` | false | 是否保留 HTML/Markdown 注释 |
| `keep_html_raw` | false | 是否保留原始 HTML block |
| `extract_html_table` | true | 是否把 HTML `<table>` 提取为 Markdown 表格 |
| `link_keep_url` | false | 链接是否保留 URL |
| `image_alt_fallback_to_filename` | true | alt 为空时是否回退到文件名 |
| `remove_empty_blocks` | true | 是否删除空 block |
| `collapse_empty_lines` | true | 是否压缩连续空行 |
| `unicode_normalize` | "NFC" | Unicode 规范化形式 |

## 质量与可观测性

### 关键指标

| 指标 | 目标 | 说明 |
|---|---|---|
| `removed_block_ratio` | < 10% | 被清洗掉的 block 比例 |
| `empty_block_ratio` | 接近 0 | 空 block 进入下游的比例 |
| `control_char_remaining_rate` | 0 | 清洗后仍残留控制字符的比例 |
| `table_corruption_rate` | 0 | 表格结构被清洗破坏的比例 |
| `code_block_altered_rate` | 0 | 代码块内容被误修改的比例 |

### 日志字段

```json
{
  "event": "document_text_cleaned",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "format": "markdown",
  "input_blocks": 120,
  "output_blocks": 115,
  "removed_blocks": 5,
  "cleaning_ops_top": ["normalize_space", "trim", "remove_comment"],
  "duration_ms": 45,
  "cleaner_version": "documind-cleaner@0.1.0"
}
```

## 与 Chunking 的衔接

Text Cleaning 的输出直接进入 Markdown Chunking：

```text
document_blocks
  -> clean_markdown()
  -> cleaned_blocks
  -> markdown_chunker()
  -> chunks
```

清洗阶段必须保证：

- 标题层级可识别（`#` 数量正确）。
- 列表标记可识别（`-` / `*` / `+` / 编号）。
- 代码块围栏完整。
- 表格 pipe 结构完整。
- `heading_path` 在清洗阶段不修改，只复制到 `cleaned_blocks`。

## 常见边界问题

| 问题 | 处理 |
|---|---|
| 代码块内包含 Markdown 注释 | 代码块内部神圣，不删除注释 |
| 行内代码含多个反引号 | 保留原样，不拆分 |
| 表格单元格含 `|` | 解析阶段应已转义 `\|`，清洗阶段保留 |
| 链接文本为空 | 使用 URL 或文件名作为文本 |
| HTML 块与 Markdown 混排 | 按 HTML 策略处理，避免破坏后续 block |
| frontmatter 格式错误 | 降级为普通代码块或段落，记录 warning |
| 数学公式跨行 | 保留 `$$` 围栏内全部内容 |
| 引用块内嵌套代码块 | 分别按 blockquote 与 code_block 规则处理 |
