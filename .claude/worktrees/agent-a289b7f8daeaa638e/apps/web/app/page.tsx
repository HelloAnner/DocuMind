import Link from "next/link";
import {
  ArrowRight,
  BookOpenText,
  FileSearch,
  Files,
  LockKeyhole,
  MessageSquareText,
  Sparkles,
} from "lucide-react";
import styles from "./landing.module.css";

const questions = [
  "Q3 采购合同的付款节点是什么？",
  "员工报销需要准备哪些材料？",
  "供应商准入需要经过哪些审批？",
];

const features = [
  {
    icon: MessageSquareText,
    title: "像聊天一样问文档",
    text: "用自然语言提问，直接获得可信结论，不再翻找散落的文件。",
  },
  {
    icon: FileSearch,
    title: "答案始终带着出处",
    text: "每个结论都关联原始文档与页码，点击即可回到证据现场。",
  },
  {
    icon: LockKeyhole,
    title: "企业知识安全可控",
    text: "权限、租户与知识库边界统一管理，让每个答案都有依据、有边界。",
  },
];

export default function LandingPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="DocuMind 首页">
          <span className={styles.mark}><BookOpenText size={18} strokeWidth={2.2} /></span>
          <span>DocuMind</span>
        </Link>
        <nav className={styles.nav} aria-label="主导航">
          <a href="#capabilities">产品能力</a>
          <a href="#security">企业安全</a>
        </nav>
        <div className={styles.actions}>
          <Link className={styles.login} href="/login">登录</Link>
          <Link className={styles.signup} href="/register">注册 <ArrowRight size={14} /></Link>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.badge}><Sparkles size={14} /> 企业文档智能问答系统</div>
        <h1>让每一份企业文档<br />都能成为可靠的答案</h1>
        <p className={styles.lead}>连接企业知识，用自然语言完成检索、理解与引用。<br />无需逐页翻找，也无需反复确认出处。</p>
        <div className={styles.heroActions}>
          <Link className={styles.primary} href="/login">开始问答 <ArrowRight size={16} /></Link>
          <a className={styles.secondary} href="#capabilities">了解产品</a>
        </div>

        <div className={styles.product} aria-label="DocuMind 产品界面预览">
          <div className={styles.productBar}>
            <div className={styles.productBrand}><span className={styles.miniMark}><BookOpenText size={13} /></span> DocuMind</div>
            <span className={styles.workspace}>企业知识空间</span>
          </div>
          <div className={styles.productBody}>
            <aside className={styles.sidebar}>
              <span className={styles.sideActive}><MessageSquareText size={15} /> 新对话</span>
              <span><Files size={15} /> 知识库</span>
              <span><FileSearch size={15} /> 文档</span>
            </aside>
            <div className={styles.demo}>
              <p className={styles.demoEyebrow}>下午好，想查找什么知识？</p>
              <h2>向 DocuMind 提问</h2>
              <div className={styles.composer}>
                <span>输入一个关于企业文档的问题...</span>
                <button aria-label="发送问题"><ArrowRight size={17} /></button>
              </div>
              <div className={styles.questions}>
                {questions.map((question) => <span key={question}>{question}<ArrowRight size={14} /></span>)}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.capabilities} id="capabilities">
        <div className={styles.sectionIntro}>
          <span>从问题到证据</span>
          <h2>复杂的企业知识，<br />现在只需要问一句。</h2>
        </div>
        <div className={styles.featureGrid}>
          {features.map(({ icon: Icon, title, text }, index) => (
            <article className={styles.feature} key={title}>
              <div className={styles.featureTop}><span>0{index + 1}</span><Icon size={21} /></div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.security} id="security">
        <div>
          <span className={styles.securityLabel}>为企业而生</span>
          <h2>知识留在企业内部，<br />答案流向每个工作现场。</h2>
        </div>
        <div className={styles.securityCopy}>
          <p>连接现有制度、合同与业务资料，在统一权限与知识边界下安全使用企业知识。</p>
          <Link href="/login">进入 DocuMind <ArrowRight size={15} /></Link>
        </div>
      </section>

      <footer className={styles.footer}>
        <span className={styles.brand}><span className={styles.mark}><BookOpenText size={18} /></span>DocuMind</span>
        <p>让知识成为每个人的工作语言。</p>
        <span>© 2026 DocuMind</span>
      </footer>
    </main>
  );
}
