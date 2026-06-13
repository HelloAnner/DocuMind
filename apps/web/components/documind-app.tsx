"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  FileSearch,
  FileText,
  Folder,
  History,
  Home,
  Layers,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

export type AppView =
  | "chat"
  | "admin"
  | "upload"
  | "members"
  | "logs"
  | "chunking"
  | "embedding"
  | "search"
  | "llm";

type NavItem = {
  label: string;
  href: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  badge?: string;
};

const adminNav: { title: string; items: NavItem[] }[] = [
  {
    title: "管理",
    items: [
      { label: "知识库", href: "/admin", icon: BookOpen },
      { label: "成员与权限", href: "/admin/members", icon: Users },
      { label: "问答日志", href: "/admin/logs", icon: History },
      { label: "文档上传", href: "/admin/upload", icon: Upload, badge: "3" },
    ],
  },
  {
    title: "配置",
    items: [
      { label: "切割策略", href: "/admin/chunking", icon: Layers },
      { label: "模型设定", href: "/admin/embedding", icon: Database },
      { label: "检索参数", href: "/admin/search", icon: SlidersHorizontal },
      { label: "LLM 服务商", href: "/admin/llm", icon: Bot },
    ],
  },
];

const documents = [
  {
    name: "2026 产品路线图.pdf",
    type: "PDF",
    owner: "产品运营",
    chunks: 47,
    status: "已入库",
    updated: "12 分钟前",
  },
  {
    name: "知识库治理手册.docx",
    type: "Word",
    owner: "平台团队",
    chunks: 132,
    status: "解析中",
    updated: "26 分钟前",
  },
  {
    name: "Q2 客户成功复盘.pptx",
    type: "PPT",
    owner: "CS 团队",
    chunks: 84,
    status: "已入库",
    updated: "今天 09:18",
  },
  {
    name: "合同审批规范.pdf",
    type: "PDF",
    owner: "法务",
    chunks: 63,
    status: "待重建",
    updated: "昨天 18:42",
  },
];

const citations = [
  {
    title: "2026 产品路线图.pdf",
    meta: "第 14 页 · 市场进入策略",
    quote: "首批私有化客户优先启用结构化引用、人工反馈闭环和知识库级别权限隔离。",
  },
  {
    title: "知识库治理手册.docx",
    meta: "第 3 节 · 入库标准",
    quote: "管理员需要按业务域维护知识库，避免跨部门文档在同一索引中混排。",
  },
  {
    title: "Q2 客户成功复盘.pptx",
    meta: "Slide 18 · 高优先级需求",
    quote: "客户最关注答案可追溯性，其次是上传后的解析进度可视化。",
  },
];

export function DocuMindApp({ view }: { view: AppView }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const title = useMemo(() => {
    if (view === "chat") return "产品文档库";
    if (view === "upload") return "文档上传与解析配置";
    if (view === "members") return "成员与权限";
    if (view === "logs") return "问答日志";
    if (view === "chunking") return "切割策略配置";
    if (view === "embedding") return "模型设定";
    if (view === "search") return "检索参数配置";
    if (view === "llm") return "LLM 服务商配置";
    return "知识库管理";
  }, [view]);

  if (view === "chat") {
    return (
      <main className="app-shell">
        <ChatSidebar />
        <section className="workspace">
          <TopBar title={title} view={view} />
          <ChatWorkspace />
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <AdminSidebar />
      <section className="workspace">
        <TopBar title={title} view={view} />
        {view === "members" ? (
          <MembersWorkspace />
        ) : view === "logs" ? (
          <LogsWorkspace />
        ) : view === "upload" ? (
          <UploadWorkspace />
        ) : ["chunking", "embedding", "search", "llm"].includes(view) ? (
          <ConfigWorkspace view={view as "chunking" | "embedding" | "search" | "llm"} />
        ) : (
          <AdminWorkspace onOpenDrawer={() => setDrawerOpen(true)} />
        )}
      </section>
      {drawerOpen && <DocumentDrawer onClose={() => setDrawerOpen(false)} />}
    </main>
  );
}

function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="side">
      <div className="side-top">
        <Link className="brand" href="/admin">
          <span className="brand-mark">
            <FileSearch size={14} />
          </span>
          <span>
            <strong>DocuMind</strong>
            <small>文档智能</small>
          </span>
        </Link>
      </div>

      <Link className="tenant-switcher admin-return-row" href="/chat">
        <ArrowLeft size={15} />
        <span>返回对话</span>
      </Link>

      <nav className="nav">
        {adminNav.map((section) => (
          <div className="nav-section" key={section.title}>
            <div className="panel-title">{section.title}</div>
            {section.items.map((item) => {
              const active =
                item.href === "/admin"
                  ? pathname === "/admin" || pathname === "/"
                  : pathname === item.href;
              const Icon = item.icon;
              return (
                <Link className={`nav-item ${active ? "active" : ""}`} href={item.href} key={item.label}>
                  <Icon size={14} />
                  <span>{item.label}</span>
                  {item.badge && <span className="badge neutral">{item.badge}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="side-footer">
        <div className="role-card">
          <Shield size={14} />
          <span>
            <strong>租户管理员</strong>
            <small>认证暂时关闭</small>
          </span>
        </div>
      </div>
    </aside>
  );
}

function ChatSidebar() {
  return (
    <aside className="side chat-side">
      <div className="side-top">
        <Link className="brand" href="/chat">
          <span className="brand-mark">
            <FileSearch size={14} />
          </span>
          <span>
            <strong>DocuMind</strong>
            <small>文档智能</small>
          </span>
        </Link>
        <button className="icon-button" aria-label="新建问答">
          <Plus size={16} />
        </button>
      </div>

      <div className="tenant-switcher">
        <Folder size={15} />
        <span>产品文档库</span>
        <ChevronDown size={14} />
      </div>

      <div className="chat-side-actions">
        <button className="button primary">
          <Plus size={14} />
          新对话
        </button>
        <button className="icon-button" aria-label="搜索对话">
          <Search size={15} />
        </button>
      </div>

      <div className="segmented chat-seg">
        <button className="selected">会话</button>
        <button>收藏</button>
        <button>分享</button>
      </div>

      <div className="chat-history-list">
        <HistoryGroup title="今天" items={["私有化上线前配置", "产品路线图里程碑"]} />
        <HistoryGroup title="昨天" items={["合同审批规范", "客户成功复盘"]} />
        <HistoryGroup title="本周" items={["权限隔离要求", "解析失败重试策略", "引用卡片口径"]} />
      </div>

      <div className="side-footer">
        <Link className="admin-entry" href="/admin">
          <Settings size={15} />
          <span>
            <strong>管理后台</strong>
            <small>知识库、文档与配置</small>
          </span>
          <ChevronRight size={14} />
        </Link>
      </div>
    </aside>
  );
}

function TopBar({ title, view }: { title: string; view: AppView }) {
  return (
    <header className="topbar">
      {view !== "chat" ? (
        <Link className="button secondary return-chat" href="/chat">
          <ArrowLeft size={16} />
          返回对话
        </Link>
      ) : null}
      <div>
        <h1>{title}</h1>
        <p>{view === "chat" ? "Acme Knowledge · bge-large-zh-v1.5 · Hybrid Search" : "Acme Knowledge · 租户管理员 · 无登录原型"}</p>
      </div>
      <span className="spacer" />
      <div className="top-search">
        <Search size={14} />
        <input placeholder="搜索文档、切片、历史问题" />
      </div>
      <button className="button secondary">
        <Download size={14} />
        导出
      </button>
      <button className="icon-button">
        <MoreHorizontal size={16} />
      </button>
    </header>
  );
}

function ChatWorkspace() {
  const [question, setQuestion] = useState("这批私有化客户上线前，文档知识库需要优先配置哪些能力？");

  return (
    <div className="chat-layout">
      <div className="chat-main">
        <div className="chat-stream">
          <div className="question-row">
            <div className="user-bubble">这批私有化客户上线前，文档知识库需要优先配置哪些能力？</div>
          </div>

          <article className="answer-card">
            <div className="answer-head">
              <span className="answer-avatar">
                <Sparkles size={15} />
              </span>
              <div>
                <strong>DocuMind</strong>
                <p>已检索 3 份文档 · 47 个切片 · 置信度 0.86</p>
              </div>
              <span className="badge success">引用完整</span>
            </div>

            <p>
              上线前建议优先完成三类配置：知识库隔离、解析与切割策略、答案溯源策略。产品路线图里把
              “结构化引用”和“权限边界”列为私有化首批能力，治理手册也要求按业务域维护知识库，避免跨部门文档在同一索引中混排。
            </p>
            <p>
              具体落地时，先为每个业务域创建独立知识库，再启用结构感知切割、保留表格结构、Hybrid
              Search 与 reranker。LLM 侧需要固定“无法检索到依据时拒答”的系统 Prompt，避免无依据生成。
            </p>

            <div className="process-card">
              <Stage label="查询改写" status="done" value="0.2s" />
              <Stage label="向量检索 + BM25 合并" status="done" value="0.8s" />
              <Stage label="Reranker 精排" status="done" value="1.1s" />
              <Stage label="答案生成" status="running" value="2.6s" />
            </div>

            <div className="citation-grid">
              {citations.map((citation) => (
                <div className="citation-card" key={citation.title}>
                  <div className="citation-meta">
                    <FileText size={14} />
                    <span>{citation.title}</span>
                  </div>
                  <strong>{citation.meta}</strong>
                  <p>{citation.quote}</p>
                </div>
              ))}
            </div>
          </article>
        </div>

        <div className="composer">
          <div className="composer-box">
            <input value={question} onChange={(event) => setQuestion(event.target.value)} />
            <button className="send-button" aria-label="发送">
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="history-group">
      <div className="panel-title">{title}</div>
      {items.map((item, index) => (
        <button className={`history-item ${index === 0 ? "active" : ""}`} key={item}>
          <MessageSquare size={13} />
          <span>{item}</span>
        </button>
      ))}
    </div>
  );
}

function AdminWorkspace({ onOpenDrawer }: { onOpenDrawer: () => void }) {
  return (
    <div className="admin-content">
      <div className="admin-detail-grid">
        <section className="panel knowledge-panel">
          <PanelHeader title="知识库" action={<span>4 个业务域</span>} />
          {[
            ["产品文档库", "1,248 文档 · 84,392 切片", "默认问答范围"],
            ["客户成功知识库", "326 文档 · 19,420 切片", "CS 团队维护"],
            ["法务制度库", "118 文档 · 7,631 切片", "需权限审批"],
            ["研发规范库", "402 文档 · 26,188 切片", "研发可见"],
          ].map(([name, meta, desc], index) => (
            <button className={`knowledge-row ${index === 0 ? "active" : ""}`} key={name}>
              <BookOpen size={15} />
              <span>
                <strong>{name}</strong>
                <small>{meta}</small>
              </span>
              <em>{desc}</em>
            </button>
          ))}
        </section>

        <section className="panel">
          <PanelHeader title="产品文档库 · 文档列表" action={<Link href="/admin/upload">上传文档</Link>} />
          <div className="table">
            <div className="table-head">
              <span>文档</span>
              <span>类型</span>
              <span>切片</span>
              <span>状态</span>
              <span>更新时间</span>
            </div>
            {documents.map((doc) => (
              <button className="table-row" key={doc.name} onClick={onOpenDrawer}>
                <span className="doc-name">
                  <FileText size={14} />
                  <span>
                    <strong>{doc.name}</strong>
                    <small>{doc.owner}</small>
                  </span>
                </span>
                <span>{doc.type}</span>
                <span>{doc.chunks}</span>
                <StatusBadge value={doc.status} />
                <span>{doc.updated}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function MembersWorkspace() {
  const members = [
    ["陈文", "租户管理员", "产品文档库、客户成功知识库", "今天 10:21"],
    ["Alice Zhang", "知识库维护者", "产品文档库", "昨天 18:02"],
    ["王可", "问答用户", "产品文档库", "今天 09:12"],
    ["Legal Ops", "只读审阅", "法务制度库", "本周二"],
  ];

  return (
    <div className="admin-content">
      <div className="admin-detail-grid">
        <section className="panel">
          <PanelHeader title="成员" action={<button className="button primary"><Plus size={14} />邀请成员</button>} />
          <div className="member-list">
            {members.map(([name, role, scope, active]) => (
              <div className="member-row" key={name}>
                <span className="avatar">{name.slice(0, 1)}</span>
                <span>
                  <strong>{name}</strong>
                  <small>{scope}</small>
                </span>
                <span className="badge neutral">{role}</span>
                <em>{active}</em>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <PanelHeader title="权限矩阵" action={<span>按知识库生效</span>} />
          <div className="permission-grid">
            <div className="permission-head"><span>角色</span><span>上传</span><span>配置</span><span>问答</span><span>日志</span></div>
            {[
              ["租户管理员", true, true, true, true],
              ["知识库维护者", true, false, true, true],
              ["问答用户", false, false, true, false],
              ["只读审阅", false, false, true, true],
            ].map(([role, upload, config, chat, logs]) => (
              <div className="permission-row" key={String(role)}>
                <span>{role}</span>
                {[upload, config, chat, logs].map((enabled, index) => (
                  <span className={enabled ? "permission-on" : "permission-off"} key={index}>
                    {enabled ? "允许" : "禁止"}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function LogsWorkspace() {
  const logs = [
    ["这批私有化客户上线前需要优先配置哪些能力？", "陈文", "产品文档库", "0.86", "已采纳", "2.8s"],
    ["合同审批规范里，例外审批需要谁确认？", "王可", "法务制度库", "0.79", "有反馈", "3.4s"],
    ["Q2 客户成功复盘中提到的高优需求有哪些？", "Alice Zhang", "客户成功知识库", "0.91", "已采纳", "2.1s"],
    ["研发规范库里的接口版本策略是什么？", "平台团队", "研发规范库", "0.42", "低置信拒答", "1.6s"],
  ];

  return (
    <div className="admin-content">
      <div className="log-toolbar">
        <div className="segmented">
          <button className="selected">全部</button>
          <button>已采纳</button>
          <button>有反馈</button>
          <button>拒答</button>
        </div>
        <div className="top-search log-search"><Search size={14} /><input placeholder="搜索问题、用户、知识库" /></div>
      </div>
      <section className="panel">
        <PanelHeader title="问答日志" action={<span>近 30 天 · 12,483 条</span>} />
        <div className="log-list">
          {logs.map(([question, user, kb, score, status, latency]) => (
            <div className="log-row" key={question}>
              <MessageSquare size={15} />
              <span>
                <strong>{question}</strong>
                <small>{user} · {kb} · 首字延迟 {latency}</small>
              </span>
              <span className="log-score">置信度 {score}</span>
              <StatusBadge value={status} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ConfigWorkspace({ view }: { view: "chunking" | "embedding" | "search" | "llm" }) {
  const meta = {
    chunking: ["切割策略", "控制文档如何被解析成可检索切片，影响召回率和引用精度。", <ChunkingForm />],
    embedding: ["模型设定", "统一管理向量化、精排和生成模型，确保各链路模型可观测、可切换。", <ModelSettingsForm />],
    search: ["检索参数", "配置召回、精排、阈值和混合检索策略。", <SearchForm />],
    llm: ["LLM 服务商", "管理多个服务商、默认模型、密钥状态和生成参数。", <LlmProvidersForm />],
  }[view] as [string, string, ReactNode];

  return (
    <div className="admin-content">
      <div className="admin-detail-grid">
        <section className="panel config-context">
          <PanelHeader title="配置说明" action={<span>当前租户</span>} />
          <h2>{meta[0]}</h2>
          <p>{meta[1]}</p>
          <HealthRow label="当前发布版本" value="v14" width="72%" />
          <HealthRow label="待审配置" value="2 项" width="38%" />
          <Notice tone="info" title="配置会即时保存为草稿" desc="保存后需要发布才会影响线上问答链路。" />
        </section>
        <section className="panel config-detail">
          <PanelHeader title={meta[0]} action={<button className="button primary">保存草稿</button>} />
          <div className="config-form">{meta[2]}</div>
        </section>
      </div>
    </div>
  );
}

function UploadWorkspace() {
  return (
    <div className="upload-content">
      <section className="upload-band">
        <div className="panel-title">上传文档</div>
        <div className="upload-row">
          <div className="drop-zone">
            <Upload size={28} />
            <strong>拖拽 Word / PPT / PDF 到这里</strong>
            <span>最大 200MB · 自动解析文本、表格和页码</span>
            <button className="button primary">选择文件</button>
          </div>
          <div className="file-preview">
            <div className="file-preview-head">
              <FileText size={18} />
              <span>
                <strong>2026 产品路线图.pdf</strong>
                <small>48.2MB · 80 页 · 等待上传</small>
              </span>
            </div>
            <Progress label="解析" value="0%" width="0%" />
            <Progress label="切割" value="0%" width="0%" />
            <Progress label="向量化" value="0%" width="0%" />
          </div>
        </div>
      </section>

      <section className="upload-config">
        <div className="config-panel">
          <div className="panel-title">解析参数配置</div>
          <Field label="切割策略" value="结构感知切分" />
          <Field label="最大切片大小" value="1500 tokens" />
          <Field label="Overlap" value="220 tokens" />
          <Field label="向量化模型" value="bge-large-zh-v1.5" />
          <Field label="文档语言" value="中文优先，自动识别英文" />
          <label className="check-row">
            <input type="checkbox" defaultChecked />
            保留表格结构
          </label>
          <label className="check-row">
            <input type="checkbox" defaultChecked />
            合并短段落
          </label>
          <div className="button-row">
            <Link className="button secondary" href="/admin">取消</Link>
            <button className="button primary">开始上传</button>
          </div>
        </div>

        <div className="preview-panel">
          <div className="tabs">
            <button className="active">解析预览</button>
            <button>切片预览</button>
            <button>元数据</button>
          </div>
          <div className="preview-block">
            <span className="panel-title">第 14 页 · 市场进入策略</span>
            <p>
              首批私有化客户优先启用结构化引用、人工反馈闭环和知识库级别权限隔离。上线前需要完成解析链路压测，
              并为关键知识库开启 hybrid search。
            </p>
          </div>
          <div className="chunk-preview">
            <span>chunk_014_003</span>
            <strong>742 tokens</strong>
            <p>heading_path: 产品路线图 / 市场进入策略 / 私有化上线</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function ConfigModal({ view }: { view: "chunking" | "embedding" | "search" | "llm" }) {
  const config = {
    chunking: {
      title: "切割策略配置",
      body: <ChunkingForm />,
    },
    embedding: {
      title: "向量化模型配置",
      body: <EmbeddingForm />,
    },
    search: {
      title: "检索参数配置",
      body: <SearchForm />,
    },
    llm: {
      title: "LLM 服务商配置",
      body: <LlmForm />,
    },
  }[view];

  return (
    <div className="modal-layer">
      <div className="modal">
        <div className="modal-head">
          <h2>{config.title}</h2>
          <Link className="icon-button" href="/admin">
            <X size={18} />
          </Link>
        </div>
        <div className="modal-body">{config.body}</div>
        <div className="modal-foot">
          <Link className="button secondary" href="/admin">取消</Link>
          <Link className="button primary" href="/admin">保存配置</Link>
        </div>
      </div>
    </div>
  );
}

function ChunkingForm() {
  return (
    <>
      <div className="panel-title">切割方案</div>
      <div className="option-strip">
        <button className="selected">结构感知</button>
        <button>固定窗口</button>
        <button>Markdown 标题</button>
      </div>
      <p className="form-note">
        按文档原生结构边界切分，保留标题、小节、表格和 slide 信息；超出最大 token 后按段落递归切分。
      </p>
      <RangeField label="最大切片大小" value="1500 tokens" />
      <RangeField label="Overlap 长度" value="220 tokens" />
      <Field label="段落分隔符" value="。；;\\n\\n" />
      <label className="check-row"><input type="checkbox" defaultChecked />保留表格结构</label>
      <label className="check-row"><input type="checkbox" defaultChecked />保留列表层级</label>
      <label className="check-row"><input type="checkbox" defaultChecked />合并短段落</label>
    </>
  );
}

function EmbeddingForm() {
  return (
    <div className="model-list">
      {[
        ["bge-large-zh-v1.5", "本地 ONNX · 1024d · 中文企业文档推荐", true],
        ["multilingual-e5-large", "本地 ONNX · 1024d · 中英混合", false],
        ["text2vec-large-chinese", "本地 ONNX · 1024d · 轻量部署", false],
        ["OpenAI text-embedding-3-large", "API · 3072d · 多语言高精度", false],
      ].map(([name, desc, selected]) => (
        <button className={`model-card ${selected ? "selected" : ""}`} key={String(name)}>
          <Database size={18} />
          <span>
            <strong>{name}</strong>
            <small>{desc}</small>
          </span>
          {selected && <Check size={18} />}
        </button>
      ))}
    </div>
  );
}

function ModelSettingsForm() {
  return (
    <div className="settings-stack">
      <section className="setting-section">
        <div className="panel-title">Embedding Model</div>
        <EmbeddingForm />
      </section>
      <section className="setting-section">
        <div className="panel-title">Reranker</div>
        <div className="model-list compact">
          {[
            ["bge-reranker-large", "默认精排 · 中文效果稳定", true],
            ["jina-reranker-v2-base-multilingual", "多语言精排 · API", false],
          ].map(([name, desc, selected]) => (
            <button className={`model-card ${selected ? "selected" : ""}`} key={String(name)}>
              <SlidersHorizontal size={18} />
              <span>
                <strong>{name}</strong>
                <small>{desc}</small>
              </span>
              {selected && <Check size={18} />}
            </button>
          ))}
        </div>
      </section>
      <section className="setting-section">
        <div className="panel-title">Generation Model</div>
        <Field label="默认生成模型" value="qwen2.5:14b" />
        <Field label="拒答模型" value="qwen2.5:7b-instruct" />
        <RangeField label="上下文窗口预算" value="24k tokens" />
      </section>
    </div>
  );
}

function SearchForm() {
  return (
    <>
      <Field label="检索 Top-K" value="8" />
      <Field label="精排 Top-K" value="5" />
      <RangeField label="相似度阈值" value="0.32" />
      <div className="panel-title">检索策略</div>
      <div className="option-strip">
        <button>Vector</button>
        <button>BM25</button>
        <button className="selected">Hybrid</button>
      </div>
      <Field label="Reranker" value="bge-reranker-large" />
    </>
  );
}

function LlmForm() {
  return (
    <>
      <Field label="服务商 API 地址" value="http://localhost:11434/v1" />
      <Field label="API Key" value="ollama" />
      <Field label="模型名称" value="qwen2.5:14b" />
      <div className="panel-title">高级参数</div>
      <RangeField label="Temperature" value="0.2" />
      <RangeField label="Max Tokens" value="4096" />
      <Field label="系统 Prompt" value="只基于引用回答，找不到依据时明确拒答" />
    </>
  );
}

function LlmProvidersForm() {
  const providers: Array<[string, string, string, string, boolean]> = [
    ["Ollama 本地", "http://localhost:11434/v1", "qwen2.5:14b", "默认", true],
    ["DashScope", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", "备用", false],
    ["OpenAI Compatible", "https://api.openai.com/v1", "gpt-4.1-mini", "未启用", false],
  ];

  return (
    <div className="settings-stack">
      <div className="provider-grid">
        {providers.map(([name, endpoint, model, status, active]) => (
          <button className={`provider-card ${active ? "active" : ""}`} key={name}>
            <Bot size={18} />
            <span>
              <strong>{name}</strong>
              <small>{endpoint}</small>
              <em>{model}</em>
            </span>
            <span className={`badge ${active ? "success" : "neutral"}`}>{status}</span>
          </button>
        ))}
      </div>
      <Field label="API Key 管理" value="3 个密钥 · 1 个即将过期" />
      <RangeField label="Temperature" value="0.2" />
      <RangeField label="Max Tokens" value="4096" />
      <Field label="系统 Prompt" value="只基于引用回答，找不到依据时明确拒答" />
      <label className="check-row"><input type="checkbox" defaultChecked />启用低置信自动拒答</label>
      <label className="check-row"><input type="checkbox" defaultChecked />记录生成链路审计日志</label>
    </div>
  );
}

function DocumentDrawer({ onClose }: { onClose: () => void }) {
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div>
          <h2>2026 产品路线图.pdf</h2>
          <p>PDF · 80 页 · 47 个切片 · 已入库</p>
        </div>
        <button className="icon-button" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="drawer-tabs">
        <button>文档信息</button>
        <button className="active">切片列表 (47)</button>
        <button>操作记录</button>
      </div>
      <div className="chunk-list">
        {Array.from({ length: 8 }).map((_, index) => (
          <div className="chunk-row" key={index}>
            <span>chunk_014_00{index + 1}</span>
            <strong>第 {14 + index} 页 · {index % 2 === 0 ? "市场进入策略" : "上线准备"}</strong>
            <p>首批私有化客户优先启用结构化引用、人工反馈闭环和知识库级别权限隔离。</p>
          </div>
        ))}
      </div>
    </aside>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

function PanelHeader({ title, action }: { title: string; action: ReactNode }) {
  return (
    <div className="panel-head">
      <div className="panel-title">{title}</div>
      <div className="panel-action">{action}</div>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const tone =
    value === "已入库" || value === "已采纳"
      ? "success"
      : value === "解析中" || value === "有反馈"
      ? "warning"
      : value === "低置信拒答"
      ? "neutral"
      : "danger";
  return <span className={`badge ${tone}`}>{value}</span>;
}

function Stage({ label, status, value }: { label: string; status: "done" | "running"; value: string }) {
  return (
    <div className="stage">
      <span className={`stage-dot ${status}`}>
        {status === "done" ? <Check size={10} /> : <Activity size={10} />}
      </span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HealthRow({ label, value, width }: { label: string; value: string; width: string }) {
  return (
    <div className="health-row">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="bar">
        <span style={{ width }} />
      </div>
    </div>
  );
}

function Notice({ tone, title, desc }: { tone: "warning" | "info"; title: string; desc: string }) {
  return (
    <div className={`notice ${tone}`}>
      <CircleAlert size={15} />
      <span>
        <strong>{title}</strong>
        <small>{desc}</small>
      </span>
    </div>
  );
}

function ConfigTile({
  href,
  icon: Icon,
  title,
  desc,
}: {
  href: string;
  icon: ComponentType<{ size?: number }>;
  title: string;
  desc: string;
}) {
  return (
    <Link className="config-tile" href={href}>
      <Icon size={16} />
      <span>
        <strong>{title}</strong>
        <small>{desc}</small>
      </span>
      <ChevronRight size={14} />
    </Link>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <label className="field-row">
      <span>{label}</span>
      <input defaultValue={value} />
    </label>
  );
}

function RangeField({ label, value }: { label: string; value: string }) {
  return (
    <div className="range-field">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <input type="range" defaultValue="70" />
    </div>
  );
}

function Progress({ label, value, width }: { label: string; value: string; width: string }) {
  return (
    <div className="progress-row">
      <span>{label}</span>
      <div className="bar">
        <span style={{ width }} />
      </div>
      <strong>{value}</strong>
    </div>
  );
}
