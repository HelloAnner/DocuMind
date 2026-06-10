# DocuMind 设计系统

对齐 Corevo / Northline 的设计语言：**单色为骨 · 层级为肉 · 几何为形**。
不用彩色强调、不用装饰性阴影、不用戏剧化过渡。界面由近黑/近白的层级对比、发丝级边框、留白节奏共同支撑。

> 所有 tokens 的真相来源是 `apps/web/app/globals.css`，本文只做语义与用法说明。新增 token 请先改 CSS 再更新本文。

---

## 1. 设计哲学

1. **单色即最强的强调**——主操作/激活态用**反相**（暗色主题下白底黑字 / 亮色主题下黑底白字），**不用**紫色、蓝色或任何品牌色作为按钮/选中背景
2. **边界由层级与背景色表达**——避免粗描边，优先靠 `--bg-primary / secondary / tertiary / elevated` 三到四层背景堆叠做纵深
3. **边框只出现在必要处**——表格、卡片、输入框用 `--border-subtle`（不透明度 0.04–0.06）的发丝线，**禁止** 1px 以上或高对比描边
4. **阴影服务于悬浮，不服务于装饰**——抽屉、下拉、模态允许柔和大模糊阴影；卡片默认无阴影，只用边框 + 背景色差
5. **彩色仅用于状态反馈**——绿/红/琥珀/蓝仅出现在 success/error/warning/info 状态，不作为 UI 主色
6. **信息密度优先于留白美学**——后台/列表用行式密排（12px 行高、发丝分隔线），只有对话/欢迎区才使用大号留白
7. **动效短而无声**——150ms 微过渡，200ms 常规，300ms 是上限；禁止超过 400ms 的"剧场式"过渡

---

## 2. 颜色系统

### 2.1 背景层级（四层）

| Token | 暗色 | 亮色 | 用途 |
|---|---|---|---|
| `--bg-primary` | `#0A0A0F` | `#FAF9F7` | 应用画布（最底层）|
| `--bg-secondary` | `#121218` | `#FFFFFF` | 卡片/面板/主操作区 |
| `--bg-tertiary` | `#16161C` | `#F5F4F2` | 侧栏、次要容器、表头、输入框基底 |
| `--bg-elevated` | `#1A1A20` | `#FFFFFF` | 悬浮容器（下拉、tooltip） |

**用法：** 永远靠背景层级差做分区，不靠描边。侧栏放 `--bg-tertiary` 贴在 `--bg-primary` 画布上，比一条 1px 竖线更内敛。

### 2.2 文字层级（五级）

| Token | 暗色 | 亮色 | 用途 |
|---|---|---|---|
| `--text-primary` | `#FAFAFA` | `#1A1A1A` | 主要内容、数字、按钮主文本 |
| `--text-secondary` | `#E4E4E7` | `#3A3A3A` | 次要正文、表格 cell |
| `--text-tertiary` | `#A1A1AA` | `#5A5A5A` | 辅助说明 |
| `--text-muted` | `#71717A` | `#7A7A7A` | 标签、图标、panel title |
| `--text-placeholder` | `#52525B` | `#9A9A9A` | 输入占位 |

### 2.3 边框（发丝）

| Token | 不透明度 | 用途 |
|---|---|---|
| `--border-subtle` | 0.04–0.06 | 默认边框（卡片、输入、表格） |
| `--border-muted` | 0.03–0.04 | 极弱分隔（列表行间） |
| `--border-faint` | 0.02–0.03 | 仅用于嵌套容器的内部分区 |

**硬规则：** 不使用 `#ddd` / `#e5e5e5` 这种带色值的实线边框。边框永远是半透明叠加。

### 2.4 交互态

| Token | 暗色 | 亮色 | 用途 |
|---|---|---|---|
| `--hover-bg` | `rgba(255,255,255,0.05)` | `rgba(0,0,0,0.04)` | 常规悬停 |
| `--hover-bg-strong` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.06)` | 导航激活、强化悬停 |
| `--selected-bg` | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.05)` | 选中（多选框、行） |
| `--active-bg` | `rgba(255,255,255,0.10)` | `rgba(0,0,0,0.08)` | 按下态 |

### 2.5 语义色（只用于状态）

```
--color-success: #22C55E    /* 完成、进度正常 */
--color-warning: #F59E0B    /* 即将过期、审阅中 */
--color-error:   #EF4444    /* 失败、已过期、删除 */
--color-info:    #3B82F6    /* 提示、链接 */
```

**用法：** 仅以 `color` 或**极低透明度的背景**（`rgba(ef4444, 0.1)`）出现在 badge / 状态点 / 错误文字。**禁止**语义色做填充按钮背景。

### 2.6 玻璃（Glass）

```
--glass-bg:    rgba(18,18,24,0.82)    /* 暗 */ | rgba(255,255,255,0.92)  /* 亮 */
--glass-blur:  12px                    /* 暗 */ | 8px                      /* 亮 */
```

**用法：** 仅用于浮层（顶栏、下拉、回到底部按钮）。性能优化过，不要把 blur 拉到 20px 以上。

---

## 3. 间距与圆角

### 3.1 间距（8pt 近似阶梯）

```
--spacing-1: 4px     --spacing-6: 14px
--spacing-2: 6px     --spacing-7: 16px
--spacing-3: 8px     --spacing-8: 20px
--spacing-4: 10px    --spacing-9: 24px
--spacing-5: 12px    --spacing-10: 32px
```

**常用节奏：**
- 图标与文字 gap：`8`
- 行式列表上下 padding：`12`
- 卡片内 padding：`16–20`
- 区块之间 gap：`24–28`
- 模态/抽屉主区 padding：`20–28`

### 3.2 圆角

```
--radius-sm:  8px    卡片、按钮、输入、下拉
--radius-md:  10px   面板、次级容器
--radius-lg:  12px   主要卡片、抽屉内部块
--radius-xl:  16px   模态/抽屉本体
--radius-2xl: 20px   超大模态（Settings 840×600）
```

**硬规则：** 不使用 `border-radius: 9999px` 的胶囊按钮，除非是 pill 分段控件或状态徽标。

---

## 4. 字体排版

**字体族：** Inter（西文） + 系统中文回退 → `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`

**字号阶梯（Corevo 实测）：**

| 场景 | 字号 | 字重 |
|---|---|---|
| 大号数字（stat card） | 26px | 700 |
| 页面标题 | 20px | 600 |
| 模态/抽屉标题 | 17px | 600 |
| 侧栏分组标题 | 15px | 600 |
| 卡片标题、表格标题 | 14–15px | 500–600 |
| 正文、行条目 | 13–14px | 400–500 |
| 表格 cell、导航项 | 13px | 400（激活 500） |
| Panel Title（caps） | 12px | 600 + `uppercase` + `letter-spacing: 0.05em` |
| 次级标签、元数据 | 11–12px | 400–500 |
| 徽标文字 | 11px | 500 |

**硬规则：**
- 字重只用 `400 / 500 / 600 / 700` 四档
- 不使用 italic（除 hero 品牌字外）
- **Panel Title 必须用 uppercase + letter-spacing 0.05em + muted 色**，不用黑体大字充当小节标题

---

## 5. 层级与深度

### 5.1 层叠原则

从底到上共四层，每层背景色微调，**不叠阴影**：

```
Canvas (bg-primary)
  └─ Panel (bg-secondary) + border-subtle
       └─ Inner row (透明 + border-bottom)
            └─ Elevated (bg-elevated)
```

### 5.2 阴影（仅浮层）

| 场景 | 阴影 |
|---|---|
| 下拉菜单 | `0 10px 40px rgba(0,0,0,0.5), 0 4px 16px rgba(0,0,0,0.3)` |
| 模态 | `0 25px 50px -12px rgba(0,0,0,0.5)` |
| 回到底部按钮 | `0 4px 12px rgba(0,0,0,0.3)` |

卡片、按钮、输入**一律无阴影**，靠边框和背景色差定层级。

---

## 6. 角色与场景模式

### 6.1 三角色体系

```
SuperAdmin（超级管理员）
  ├── 全局配置（模型 Provider、向量库、系统参数）
  ├── 租户管理（创建/启停/配额）
  └── 审计日志、运维监控

TenantAdmin（租户管理员 / 知识库管理员）
  ├── 知识库 CRUD
  ├── 文档上传与管理（Word / PPT / PDF）
  ├── 切割策略与检索参数配置
  ├── 问答统计与日志
  └── 本租户用户管理

EndUser（普通用户）
  ├── 自然语言问答（在授权知识库范围内）
  ├── 历史问答、反馈（赞/踩）
  └── 个人设置
```

**Graph 隔离：** `AgentGraphFactory` 按登录角色创建三套 Rust Graph——节点实现共享，Prompt 与检索边界按角色和租户隔离。

### 6.2 场景模式

不同场景对设计语言的权重不同，下表给出取舍。**与 Northline 结构完全一致，仅内容域不同（文档 RAG vs NL2SQL）。**

| 场景 | 导航 | 密度 | 卡片/列表 | 示例页面 |
|---|---|---|---|---|
| **对话** | 侧栏（固定 240px） | 低（bubble 间距 16–24px） | 无卡片（气泡） | `/chat` |
| **欢迎/登录** | 无 | 极低（大号留白） | 单一焦点 | `/login` `/invite` |
| **设置（快进快出）** | 模态内左栏 | 中 | 行式列表为主 | Settings 模态 |
| **后台管理（沉浸）** | 全屏顶栏或左栏 | 高 | 行式 + Stat 卡 | `/admin` `/enterprise` |
| **详情抽屉** | 抽屉内 tabs | 中 | 行式 | 文档详情、切片详情 |

### 6.3 场景详解

#### 对话 — `/chat`

RAG 问答主界面。左侧历史对话列表（按知识库分组），右侧问答流：用户问题气泡（bg-tertiary）→ AI 回答卡片（bg-secondary + border-subtle）→ 原文引用卡片列表 → 底部固定输入区。

- 知识库选择器位于顶栏或输入区上方
- 答案流式逐字展示（SSE），引用卡片在回答写完后整体出现
- 空状态：`"向你的文档提问"` 引导文案 + 示例问题
- 无对话时右侧展示所选知识库的文档概览 Stat 卡

#### 欢迎/登录 — `/login` `/invite`

与 Northline 完全一致的 hero 模式：冷白/近黑画布 + 蓝紫粉渐变光球 + 粗体中文文案。单一视觉焦点，用户单击操作。

#### 设置 — Settings 居中模态

840×600 居中模态，左侧导航（220px），右侧行式列表。设置项：

- **General**：知识库名称、描述、公开性
- **Chunking**：切割策略（结构感知 / 递归 / 固定大小）、chunk size、overlap
- **Embedding**：模型选择（bge-large-zh / e5-large / API）、维度
- **Retrieval**：Top-K、Rerank 阈值、混合检索权重
- **LLM**：Provider 地址、API Key、模型名、temperature

#### 后台管理 — `/admin` `/enterprise`

全屏沉浸式布局，顶栏 + 左侧导航（可选）。Stat 卡片锚定骨架（总文档数、总切片数、问答量、检索命中率），下方为行式列表（文档列表、用户列表、租户列表）。

- 文档管理：文档行式列表（文件名 + 类型图标 + 解析状态 Badge + 切片数 + 上传时间），顶部 [上传文档] 按钮
- 知识库管理：知识库卡片网格，每卡显示文档数/切片数/问答量
- 租户管理（仅 SuperAdmin）：租户行式列表 + 配额 + 启停开关

#### 详情抽屉 — Drawer

520px 右侧滑入抽屉，抽屉内可含 tabs：

- **文档详情**：元数据、解析状态、切片预览列表（点击跳转到对应切片详情）
- **切片详情**：原文内容 + heading path + 向量检索的相似切片
- **问答详情**：问题 + 回答 + 检索到的所有候选切片 + 用户反馈

---

## 7. 组件规范

### 7.1 按钮

```
Primary     bg: var(--text-primary)      color: var(--bg-primary)     /* 反相 */
Secondary   bg: transparent               color: var(--text-muted)
            border: 1px solid var(--border-subtle)
            hover: color→primary, border→text-muted
Ghost       bg: transparent               color: var(--text-muted)    /* 取消/帮助 */
            hover: color→primary
Danger      bg: transparent               color: #e05252
            border: 1px solid #e05252     hover: bg→#e05252, color→#fff（反相）
```

**尺寸：** 高度 `34 / 38 / 40`，水平 padding `14–20`，圆角 `8–10`。
**禁止：** 紫色/蓝色/渐变色填充按钮；`box-shadow` 装饰按钮。

### 7.2 输入框

```
bg: var(--input-bg)            /* 暗色: rgba(22,22,28,0.5) | 亮色: #FFFFFF */
border: 1px solid var(--border-subtle)
border-radius: 8px
font-size: 13–14px
padding: 8–10px 12–14px
focus: border-color → var(--text-muted)  /* 不用色相高亮 */
```

**无 label 上浮动画。** Label 用 `12px muted` 放在输入框正上方。

### 7.3 列表行 vs 卡片

**行式列表**（信息密、可扫描）：
```
padding: 12px 0;              /* 不加左右 padding，靠容器控 */
border-bottom: 1px solid var(--border-subtle);
display: flex; justify-content: space-between;
```
用于：文档列表、知识库列表、用户列表、配置项。

**卡片**（需要视觉分组）：
```
padding: 16–20px;
border: 1px solid var(--border-subtle);
border-radius: 10–12px;
background: var(--bg-secondary);
```
用于：Stat 卡、知识库卡片、模块容器。

**判断规则：** 同一页同层级元素数量 ≥ 4 用行式，< 4 用卡片。

### 7.4 Stat 卡片

```
┌──────────────────┐
│ 小标签 (12px muted)      │
│ 26 (700, 1 line-height)  │
│ 次级指标 (11px muted)    │
└──────────────────┘
```

- 容器：`padding: 16px 20px; border-radius: 10px; bg-secondary + border-subtle`
- 网格：`grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px`
- hover：`translateY(-2px)`，不加阴影

**DocuMind 典型 Stat 指标：** 总文档数、总切片数、问答总量、检索命中率、平均置信度。

### 7.5 Panel（面板 / 区块）

```
container: bg-secondary + border-subtle + radius-md + padding: 16–20
title:     12px 600 muted uppercase letter-spacing-0.05em
           margin-bottom: 12
body:      gap 由内容决定
```

### 7.6 导航（分组侧栏）

```
Section Label (11px 500 muted, letter-spacing: 0.02em)
  Item Button
    padding: 8–10px
    radius: 8
    active: bg = var(--hover-bg)  + text-primary + weight-500
    idle:   bg = transparent      + text-muted
    hover:  bg = var(--hover-bg)
  Item Button
(下一分组)
Section Label
  ...
```

**硬规则：**
- 不做折叠/手风琴——层级通过分组标签和缩进表达
- 当前知识库放在分组标签下作为**纯展示卡片**（有边框但不可点）
- 侧栏宽度 `240px`（对话/管理全屏）、`220px`（模态内左栏）

### 7.7 顶栏 Tab（选一，不与侧栏共存）

```
container: padding 12px 24px; border-bottom: 1px solid var(--border-subtle)
active:    bg = text-primary; color = bg-primary; weight = 600; radius = 6
idle:      bg = transparent;  color = text-muted
```

### 7.8 Segmented Control（二选一/三选一）

用于主题切换、检索模式切换等 mutually-exclusive 选项：
```
outer:  radius: 20px; overflow: hidden;
        border: 1px solid var(--border-subtle);
        background: var(--bg-tertiary);
inner:  padding: 6px 14px; fontSize: 12;
        active: bg = hover-bg-strong + color = text-primary + weight 500
        idle:   bg = transparent     + color = text-muted   + weight 400
```

### 7.9 Badge / 徽标

```
padding: 2px 8–10px;
border-radius: 4–6px;
font-size: 11px;
font-weight: 500;

默认:    bg = hover-bg            color = text-muted
状态:    bg = 语义色 10%透明度    color = 语义色
状态点:  6px 圆点 + 语义色
```

**文档解析状态 Badge：**
- 解析完成：`color-success` + `rgba(34,197,94,0.1)` bg
- 解析中：`color-warning` + `rgba(245,158,11,0.1)` bg
- 解析失败：`color-error` + `rgba(239,68,68,0.1)` bg
- 待处理：默认灰色 badge

### 7.10 抽屉（Drawer）

```
position: fixed; top:0 right:0 bottom:0;
width: 520px (max-width: 90vw);
background: var(--bg-primary);
border-left: 1px solid var(--border-subtle);
z-index: 101;

header:   padding 14px 20px; border-bottom 1px subtle
tabs:     padding 8px 20px;  border-bottom 1px subtle（可选）
body:     flex-1 overflow-auto; padding 20px
```

配合 `overlay: rgba(0,0,0,0.4)` 作为背景遮罩。

**DocuMind 抽屉场景：** 文档详情、切片详情、问答详情、用户反馈记录。

### 7.11 模态（Modal）

**居中模态（设置类）：**
```
宽: 840px, 高: 600px
背景: var(--modal-bg)           /* 暗: #18181B | 亮: #FFFFFF */
边框: 1px solid var(--modal-border)
圆角: 20px
阴影: 0 25px 50px -12px rgba(0,0,0,0.5)
遮罩: var(--modal-backdrop) = rgba(0,0,0,0.7)

入场: fadeIn 150ms + scale 0.97→1
```

**全屏接管（管理控制台类）：**
```
position: fixed; inset: 0; z-index: 9999;
background: var(--bg-primary);
顶部 header 12px 24px + bottom border
```

### 7.12 引用卡片（Citation Card — DocuMind 专属）

答案中的每一条原文引用：

```
┌──────────────────────────────────────────────┐
│  [1] 2025销售策略.pptx · 第 3–4 页          │
│  ────────────────────────────────────────── │
│  "Q1 华东区域销售目标为 1200 万元，较去年     │
│   同期增长 15%，其中新客户占比不低于 30%..."   │
│                                              │
│  置信度: 高 (0.92)                           │
└──────────────────────────────────────────────┘

样式:
- bg: bg-tertiary, border: 1px solid border-subtle
- border-radius: 8px, padding: 12px 14px
- 标题行: 12px/500 text-secondary
- 原文: 13px/400 text-primary, line-height 1.6
- 置信度: 11px/400 text-muted
- hover: bg → hover-bg
- click: 打开文档预览抽屉，定位到对应页
```

---

## 8. 交互与动效

### 8.1 过渡时长

```
--transition-fast:   150ms   /* 按钮色变、悬停 */
--transition-normal: 200ms   /* 展开/收起、状态切换 */
--transition-slow:   300ms   /* 抽屉滑入、模态出现 */
--ease-default:      cubic-bezier(0.4, 0, 0.2, 1)
```

**硬规则：**
- 单元素过渡 ≤ 300ms
- 大块内容移动（抽屉、模态）用 200–300ms
- 不使用 spring / bounce / 回弹
- 不使用 framer-motion 的 `whileHover` 做大幅度位移（`translateY(-2px)` 是上限）

### 8.2 焦点

- 禁用浏览器默认蓝色 outline
- focus 态靠 `border-color` 提升到 `--text-muted` 或 `--text-tertiary`
- 不叠 `box-shadow` 作为 focus ring

### 8.3 加载

- Spinner：细圆环，`color: text-muted`，1s 线性旋转
- Skeleton：`bg: --skeleton-bg` + shine 动画（1200ms 循环）
- 列表加载用 Skeleton，单点操作用 Spinner

### 8.4 问答流式输出（DocuMind 专属）

- AI 回答逐字展示（SSE 流式），类似打字效果
- 引用卡片在答案写完后整体出现（避免布局跳动）
- 用户问题气泡从底部滑入（`translateY(8px) → 0`, 200ms）

---

## 9. Do / Don't

### Do

- 用**反相**表达激活态（白/黑对调），不用色相
- 用 `uppercase + letter-spacing` 的小号 muted 标签作为分组/面板标题
- 用背景层级差表达分区，边框只做辅助
- 邀请状态、配额进度用**语义色 + 细进度条**，不用 emoji
- 行式列表 hairline 分隔，卡片收敛到关键容器
- Stat 卡片用大号数字（26px/700）+ 小号 muted 标签锚定骨架
- 抽屉从右侧滑入，模态从中心淡入，全屏页覆盖画布

### Don't

- **不用紫色/蓝色做按钮或选中态填充背景**
- **不用渐变做按钮背景**——主按钮永远是反相单色
- **不用 > 1px 的粗描边**，不用 `#ddd` 等带色实线
- **不用 emoji 表达语义**——用 lucide icon + 语义色
- **不用 box-shadow 做卡片装饰**——卡片靠边框，阴影只给浮层
- **不用大号粗体中文标题**作为 panel title——那是 hero 专属
- **不用 spring/bounce 过渡**，不用 framer-motion 的大幅位移
- **不用数据仪表盘式的多指标堆叠**——只留当前任务所需的 3–6 个指标
- **不用圆润/拟物/暖色卡通风格的 UI**

---

## 10. 品牌例外：Hero / 欢迎页

`/login`、`/invite`、Onboarding 这类首次触达页面允许使用品牌元素，但仅限：

1. **冷白画布**（light）或近黑画布（dark） + **蓝紫粉渐变光球**（`linear-gradient(135deg, #6366F1, #8B5CF6, #EC4899)` + `blur(60px)` + 低透明度）
2. **粗体中文 + italic hero 文案**（`font-weight: 700; font-style: italic`），字号 32–56px
3. 渐变光球**只出现在 hero 区域背景**，不进入主应用界面
4. 主应用（侧栏打开之后）严格遵守本文档其他章节

> 例外不等于自由。Hero 也只允许**一处**视觉焦点，禁止同时使用大字 + 渐变光球 + 插画 + 多色按钮。

---

## 11. 参考

- **Corevo**（内部项目）—— 本系统的直接蓝本
- **Northline** —— 姐妹项目，界面结构与设计语言完全对齐
- **Linear** —— 单色激活、密度、uppercase 标签
- **Vercel** —— 发丝边框、行式列表、clean stat
- **Arc / Rauno Freiberg** —— 微交互克制、无装饰阴影
- **Dieter Rams / 深泽直人 / 原研哉** —— "少"的哲学内核
