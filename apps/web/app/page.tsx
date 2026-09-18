import Link from "next/link";
import {
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  FileSearch,
  Files,
  LockKeyhole,
  MessageSquareText,
  Quote,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { BrandMark } from "@/components/ui/brand-mark";
import styles from "./landing.module.css";

const capabilities = [
  {
    icon: FileSearch,
    number: "01",
    title: "答案可追溯",
    text: "每个结论都关联原始文档与页码，点击即可回到证据现场。",
  },
  {
    icon: Files,
    number: "02",
    title: "多格式统一理解",
    text: "集中处理制度、合同、手册与报告，让分散知识拥有同一个入口。",
  },
  {
    icon: ShieldCheck,
    number: "03",
    title: "权限天然隔离",
    text: "租户、角色与知识库权限贯穿检索链路，企业边界始终清晰。",
  },
];

export default function LandingPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="DocuMind 首页">
          <BrandMark />
        </Link>
        <nav className={styles.nav} aria-label="官网导航">
          <a href="#product">产品体验</a>
          <a href="#capabilities">核心能力</a>
          <a href="#security">企业安全</a>
        </nav>
        <div className={styles.actions}>
          <Link className={styles.login} href="/login">登录</Link>
          <Link className={styles.signup} href="/register">免费开始 <ArrowRight size={14} /></Link>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}><Sparkles size={14} /> 企业文档智能问答</div>
          <h1>让沉默的文档，<br /><em>开口回答。</em></h1>
          <p>把散落在企业各处的制度、合同与业务资料，变成每个人都能直接对话的可信知识。</p>
          <div className={styles.heroActions}>
            <Link className={styles.primary} href="/login">开始提问 <ArrowRight size={16} /></Link>
            <a className={styles.secondary} href="#product">看看如何工作</a>
          </div>
          <div className={styles.trustLine}>
            <span><CheckCircle2 size={14} /> 原文引用</span>
            <span><CheckCircle2 size={14} /> 权限隔离</span>
            <span><CheckCircle2 size={14} /> 私有部署</span>
          </div>
        </div>

        <div className={styles.documentStack} aria-hidden="true">
          <div className={styles.paperBack} />
          <div className={styles.paperMiddle} />
          <div className={styles.paperFront}>
            <div className={styles.paperMeta}><span>内部制度</span><span>第 12 页</span></div>
            <h2>差旅费用管理办法</h2>
            <div className={styles.rule} />
            <p>员工因公出差产生的交通、住宿及市内交通费用，应当按照对应职级标准据实报销……</p>
            <mark>住宿标准按城市类别与员工职级分别执行。</mark>
            <div className={styles.answerTag}><Quote size={14} /> 已被答案引用</div>
          </div>
        </div>
      </section>

      <section className={styles.productSection} id="product">
        <div className={styles.sectionLabel}>从提问到证据</div>
        <div className={styles.product} aria-label="DocuMind 对话界面预览">
          <aside className={styles.sidebar}>
            <div className={styles.productBrand}><BookOpenText size={17} /> DocuMind</div>
            <span className={styles.newChat}><MessageSquareText size={15} /> 新对话</span>
            <span>差旅报销标准</span>
            <span>供应商准入流程</span>
            <span>年度休假制度</span>
            <div className={styles.space}><LockKeyhole size={14} /> 企业知识空间</div>
          </aside>
          <div className={styles.chat}>
            <div className={styles.question}>北京地区高级经理出差，住宿标准是多少？</div>
            <div className={styles.answer}>
              <div className={styles.answerIcon}><Sparkles size={16} /></div>
              <div>
                <p>按照《差旅费用管理办法》，北京属于一类城市，高级经理的住宿标准为<strong>每晚不超过 800 元</strong>，凭合规发票据实报销。</p>
                <div className={styles.citation}><FileSearch size={14} /><span>差旅费用管理办法.pdf · 第 12 页</span><ArrowRight size={13} /></div>
              </div>
            </div>
            <div className={styles.composer}><span>继续询问企业知识…</span><button aria-label="发送"><ArrowRight size={17} /></button></div>
          </div>
        </div>
      </section>

      <section className={styles.capabilities} id="capabilities">
        <div className={styles.sectionIntro}>
          <span>可信知识，不只是搜索</span>
          <h2>在正确的权限里，<br />找到有出处的答案。</h2>
        </div>
        <div className={styles.featureGrid}>
          {capabilities.map(({ icon: Icon, number, title, text }) => (
            <article className={styles.feature} key={title}>
              <div className={styles.featureTop}><span>{number}</span><Icon size={22} /></div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.security} id="security">
        <div className={styles.securityMark}><LockKeyhole size={26} /></div>
        <div>
          <span>为企业边界而设计</span>
          <h2>知识被理解，<br />边界不被打破。</h2>
        </div>
        <div className={styles.securityCopy}>
          <p>独立租户、细粒度知识库权限与完整引用链路，让 AI 在可控范围内服务每一次决策。</p>
          <Link href="/register">创建企业知识空间 <ArrowRight size={15} /></Link>
        </div>
      </section>

      <footer className={styles.footer}>
        <BrandMark />
        <p>让企业知识，随问随答。</p>
        <span>© 2026 DocuMind</span>
      </footer>
    </main>
  );
}
