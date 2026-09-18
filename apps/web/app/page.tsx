import Link from "next/link";
import {
  ArrowRight,
  BookOpenText,
  Check,
  CheckCircle2,
  FileSearch,
  Files,
  Fingerprint,
  LockKeyhole,
  MessageSquareText,
  Quote,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { BrandMark } from "@/components/ui/brand-mark";
import styles from "./landing.module.css";

const capabilities = [
  {
    icon: FileSearch,
    number: "01",
    title: "答案有据可查",
    text: "每个结论都指向原始文档、页码与上下文。不是猜测，是可以复核的证据。",
  },
  {
    icon: Files,
    number: "02",
    title: "知识统一理解",
    text: "制度、合同、手册与报告集中接入，让散落的信息拥有同一个提问入口。",
  },
  {
    icon: Fingerprint,
    number: "03",
    title: "权限原样继承",
    text: "谁能看到什么，AI 就回答什么。租户与知识库边界贯穿完整检索链路。",
  },
];

const workflow = [
  ["01", "连接", "接入企业文档"],
  ["02", "理解", "构建可信索引"],
  ["03", "回答", "返回答案与出处"],
];

export default function LandingPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="DocuMind 首页">
          <BrandMark />
        </Link>
        <nav className={styles.nav} aria-label="官网导航">
          <a href="#product">产品</a>
          <a href="#capabilities">能力</a>
          <a href="#security">安全</a>
        </nav>
        <div className={styles.actions}>
          <Link className={styles.login} href="/login">登录</Link>
          <Link className={styles.signup} href="/register">创建知识空间 <ArrowRight size={14} /></Link>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}><span>DOCUMIND / 2026</span><span>企业知识智能</span></div>
          <h1>让每一份文档，<br />成为<em>可靠的答案。</em></h1>
          <p>把制度、合同与业务资料交给 DocuMind。团队只需提问，就能获得带原文出处、符合权限边界的答案。</p>
          <div className={styles.heroActions}>
            <Link className={styles.primary} href="/login">进入 DocuMind <ArrowRight size={16} /></Link>
            <a className={styles.secondary} href="#product">查看产品演示</a>
          </div>
          <div className={styles.trustLine}>
            <span><CheckCircle2 size={14} /> 原文引用</span>
            <span><CheckCircle2 size={14} /> 权限隔离</span>
            <span><CheckCircle2 size={14} /> 私有部署</span>
          </div>
        </div>

        <div className={styles.heroVisual} aria-label="DocuMind 回答示例">
          <div className={styles.visualGrid} aria-hidden="true" />
          <div className={styles.answerCard}>
            <div className={styles.cardHeader}>
              <span><Sparkles size={14} /> DocuMind 正在回答</span>
              <span className={styles.liveDot}>已连接知识库</span>
            </div>
            <div className={styles.query}><Search size={16} /> 高级经理在北京出差，住宿标准是多少？</div>
            <div className={styles.answerText}>
              <span className={styles.answerIndex}>A</span>
              <p>北京属于一类城市，高级经理住宿标准为<strong>每晚不超过 800 元</strong>，凭合规发票据实报销。</p>
            </div>
            <div className={styles.source}>
              <div><BookOpenText size={16} /><span><strong>差旅费用管理办法.pdf</strong><small>第 12 页 · 相关度 96%</small></span></div>
              <ArrowRight size={15} />
            </div>
          </div>
          <div className={styles.annotation}><Quote size={14} /> 答案与原文双向追溯</div>
        </div>
      </section>

      <section className={styles.proofRail} aria-label="产品特性">
        <span>为企业知识而生</span>
        <div><strong>100%</strong><small>答案带来源</small></div>
        <div><strong>多租户</strong><small>数据严格隔离</small></div>
        <div><strong>全格式</strong><small>统一知识入口</small></div>
      </section>

      <section className={styles.productSection} id="product">
        <div className={styles.sectionHeading}>
          <span>01 / PRODUCT</span>
          <h2>不是把搜索框换成聊天框。<br /><em>而是把证据带回答案里。</em></h2>
        </div>
        <div className={styles.product} aria-label="DocuMind 对话界面预览">
          <div className={styles.windowBar}><span /><span /><span /><small>企业知识空间 / 对话</small></div>
          <div className={styles.productBody}>
            <aside className={styles.sidebar}>
              <div className={styles.productBrand}><BookOpenText size={17} /> DocuMind</div>
              <span className={styles.newChat}><MessageSquareText size={15} /> 新对话</span>
              <small>最近对话</small>
              <span>差旅报销标准</span>
              <span>供应商准入流程</span>
              <span>年度休假制度</span>
              <div className={styles.space}><LockKeyhole size={14} /> 企业知识空间</div>
            </aside>
            <div className={styles.chat}>
              <div className={styles.question}>新供应商需要经过哪些审批环节？</div>
              <div className={styles.answer}>
                <div className={styles.answerIcon}><Sparkles size={16} /></div>
                <div>
                  <p>新供应商需依次完成<strong>资质初审、业务部门复核、合规审查与采购负责人审批</strong>。涉及关键物料时，还需补充现场审核。</p>
                  <div className={styles.citation}><FileSearch size={14} /><span>供应商管理制度.pdf · 第 8–9 页</span><ArrowRight size={13} /></div>
                </div>
              </div>
              <div className={styles.composer}><span>继续询问企业知识…</span><button aria-label="发送"><ArrowRight size={17} /></button></div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.capabilities} id="capabilities">
        <div className={styles.sectionHeading}>
          <span>02 / CAPABILITIES</span>
          <h2>企业知识，需要的不是更多信息，<br /><em>而是更确定的结论。</em></h2>
        </div>
        <div className={styles.featureGrid}>
          {capabilities.map(({ icon: Icon, number, title, text }) => (
            <article className={styles.feature} key={title}>
              <div className={styles.featureTop}><span>{number}</span><Icon size={23} /></div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
        <div className={styles.workflow}>
          {workflow.map(([number, title, text]) => (
            <div key={number}><span>{number}</span><strong>{title}</strong><small>{text}</small><Check size={16} /></div>
          ))}
        </div>
      </section>

      <section className={styles.security} id="security">
        <div className={styles.securityMark}><ShieldCheck size={28} /></div>
        <div>
          <span>03 / SECURITY</span>
          <h2>知识被理解，<br />边界不被打破。</h2>
        </div>
        <div className={styles.securityCopy}>
          <p>独立租户、细粒度知识库权限与完整引用链路，让 AI 只在被授权的范围内回答。</p>
          <ul>
            <li><Check size={14} /> 私有化部署</li>
            <li><Check size={14} /> 角色与知识库权限</li>
            <li><Check size={14} /> 全链路可追溯</li>
          </ul>
        </div>
      </section>

      <section className={styles.finalCta}>
        <span>YOUR KNOWLEDGE, READY TO ANSWER.</span>
        <h2>让企业知识，<br /><em>从今天开始回答。</em></h2>
        <Link href="/register">创建企业知识空间 <ArrowRight size={16} /></Link>
      </section>

      <footer className={styles.footer}>
        <BrandMark />
        <p>可信、可控、可追溯的企业知识智能。</p>
        <span>© 2026 DocuMind</span>
      </footer>
    </main>
  );
}
