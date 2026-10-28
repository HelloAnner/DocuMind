"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  BadgeCheck,
  ChevronRight,
  CircleAlert,
  RefreshCw,
  SearchCheck,
  Sparkles,
  ThumbsDown,
  Users,
  X,
} from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Segmented } from "@/components/ui/segmented";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";
import styles from "./admin-answer-quality.module.css";

type QualityTab = "cases" | "corrections";
type CaseStatus = "open" | "in_review" | "resolved" | "dismissed";
type RootCause =
  | "knowledge_missing"
  | "knowledge_outdated"
  | "knowledge_conflict"
  | "query_rewrite_error"
  | "retrieval_miss"
  | "rerank_drop"
  | "kb_scope_error"
  | "generation_error"
  | "citation_mismatch"
  | "ambiguous_question"
  | "no_issue"
  | "unknown";
type CorrectionStatus = "draft" | "needs_review" | "published" | "archived";

interface QualitySummary {
  pending_cases: number;
  published_corrections: number;
  needs_review: number;
  downvote_rate: number;
  feedback_coverage: number;
}

interface QualityCase {
  id: string;
  canonical_question: string;
  kb_ids: string[];
  status: CaseStatus;
  suggested_cause: RootCause | null;
  root_cause: RootCause | null;
  resolution_note: string | null;
  correction_id: string | null;
  active_downvotes: number;
  affected_users: number;
  total_reports: number;
  diagnostic_snapshot: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
}

interface QualityCaseItem {
  id: string;
  user_name: string;
  question: string;
  answer: string;
  reason: string | null;
  comment: string | null;
  suggested_correction: string | null;
  active: boolean;
  updated_at: string;
}

interface CaseEvidence {
  answer?: string;
  question?: string;
  rewritten_query?: string | null;
  retrieval_traces?: Array<Record<string, unknown>>;
  citations?: Array<{
    doc_id: string;
    chunk_id: string;
    doc_title: string;
    quote: string;
    page_range: number[];
  }>;
}

interface QualityCaseDetail extends QualityCase {
  items: QualityCaseItem[];
  evidence: CaseEvidence | null;
}

interface Correction {
  id: string;
  status: CorrectionStatus;
  source_case_id: string | null;
  required_kb_ids: string[];
  published_version_id: string | null;
  draft_version_id: string | null;
  latest_version: number;
  canonical_question: string;
  answer_markdown: string;
  change_note: string | null;
  index_status: string;
  hit_count: number;
  valid_until: string | null;
  published_at: string | null;
  updated_at: string;
}

interface CorrectionDetail extends Correction {
  aliases: string[];
  sources: Array<{
    kb_id: string | null;
    doc_id: string | null;
    chunk_id: string | null;
    source_title: string;
    quote: string;
    page_range: number[];
  }>;
}

interface CorrectionEditor {
  id: string | null;
  sourceCaseId: string | null;
  question: string;
  answer: string;
  aliases: string;
  changeNote: string;
  validUntil: string;
  requiredKbIds: string[];
  sources: CorrectionDetail["sources"];
}

const tabs = [
  { value: "cases", label: "待处理问题" },
  { value: "corrections", label: "标准答案库" },
] as const;

const caseStatusLabels: Record<CaseStatus, string> = {
  open: "待处理",
  in_review: "分析中",
  resolved: "已解决",
  dismissed: "已忽略",
};

const rootCauseLabels: Record<RootCause, string> = {
  knowledge_missing: "知识缺失",
  knowledge_outdated: "知识已过期",
  knowledge_conflict: "知识相互冲突",
  query_rewrite_error: "问题改写错误",
  retrieval_miss: "未召回有效证据",
  rerank_drop: "重排遗漏",
  kb_scope_error: "知识库范围错误",
  generation_error: "生成理解错误",
  citation_mismatch: "引用与答案不符",
  ambiguous_question: "问题表述不明确",
  no_issue: "未发现问题",
  unknown: "暂无法判断",
};

const correctionStatusLabels: Record<CorrectionStatus, string> = {
  draft: "草稿",
  needs_review: "待复核",
  published: "已发布",
  archived: "已归档",
};

function emptyEditor(): CorrectionEditor {
  return {
    id: null,
    sourceCaseId: null,
    question: "",
    answer: "",
    aliases: "",
    changeNote: "",
    validUntil: "",
    requiredKbIds: [],
    sources: [],
  };
}

function caseTone(status: CaseStatus): BadgeTone {
  if (status === "resolved") return "success";
  if (status === "in_review") return "info";
  if (status === "dismissed") return "neutral";
  return "warning";
}

function correctionTone(status: CorrectionStatus): BadgeTone {
  if (status === "published") return "success";
  if (status === "needs_review") return "warning";
  if (status === "archived") return "neutral";
  return "info";
}

function readableDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function AdminAnswerQuality() {
  const [tab, setTab] = useState<QualityTab>("cases");
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState<QualitySummary | null>(null);
  const [cases, setCases] = useState<QualityCase[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [caseDetail, setCaseDetail] = useState<QualityCaseDetail | null>(null);
  const [correctionDetail, setCorrectionDetail] = useState<CorrectionDetail | null>(null);
  const [editor, setEditor] = useState<CorrectionEditor | null>(null);
  const [rootCause, setRootCause] = useState<RootCause | "">("");
  const [caseStatus, setCaseStatus] = useState<CaseStatus>("in_review");
  const [resolutionNote, setResolutionNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const visibleCases = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ""
      ? cases
      : cases.filter((item) => item.canonical_question.toLowerCase().includes(needle));
  }, [cases, query]);

  const visibleCorrections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ""
      ? corrections
      : corrections.filter((item) =>
          `${item.canonical_question} ${item.answer_markdown}`.toLowerCase().includes(needle)
        );
  }, [corrections, query]);

  async function loadOverview() {
    setLoading(true);
    setError("");
    try {
      const [nextSummary, caseResult, correctionResult] = await Promise.all([
        fetchJson<QualitySummary>("/api/admin/answer-quality/summary"),
        fetchJson<{ items: QualityCase[] }>("/api/admin/answer-quality/cases?limit=200"),
        fetchJson<{ items: Correction[] }>("/api/admin/answer-corrections?limit=200"),
      ]);
      setSummary(nextSummary);
      setCases(caseResult.items);
      setCorrections(correctionResult.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "答案治理数据加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadOverview();
  }, []);

  async function openCase(id: string) {
    setError("");
    setEditor(null);
    setCorrectionDetail(null);
    try {
      const detail = await fetchJson<QualityCaseDetail>(`/api/admin/answer-quality/cases/${id}`);
      setCaseDetail(detail);
      setRootCause(detail.root_cause ?? detail.suggested_cause ?? "");
      setCaseStatus(detail.status === "open" ? "in_review" : detail.status);
      setResolutionNote(detail.resolution_note ?? "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "问题详情加载失败");
    }
  }

  async function openCorrection(id: string) {
    setError("");
    setCaseDetail(null);
    try {
      const detail = await fetchJson<CorrectionDetail>(`/api/admin/answer-corrections/${id}`);
      setCorrectionDetail(detail);
      setEditor({
        id: detail.id,
        sourceCaseId: detail.source_case_id,
        question: detail.canonical_question,
        answer: detail.answer_markdown,
        aliases: detail.aliases.join("\n"),
        changeNote: detail.change_note ?? "",
        validUntil: detail.valid_until ? detail.valid_until.slice(0, 10) : "",
        requiredKbIds: detail.required_kb_ids,
        sources: detail.sources,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "标准答案加载失败");
    }
  }

  async function diagnose() {
    if (!caseDetail) return;
    setWorking(true);
    setError("");
    try {
      const result = await fetchJson<{ suggested_cause: RootCause; reason: string }>(
        `/api/admin/answer-quality/cases/${caseDetail.id}/diagnose`,
        { method: "POST" }
      );
      setRootCause(result.suggested_cause);
      setNotice(result.reason);
      await Promise.all([openCase(caseDetail.id), loadOverview()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "自动诊断失败");
    } finally {
      setWorking(false);
    }
  }

  async function saveCase() {
    if (!caseDetail) return;
    setWorking(true);
    setError("");
    try {
      await fetchJson(`/api/admin/answer-quality/cases/${caseDetail.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: caseStatus,
          root_cause: rootCause || undefined,
          resolution_note: resolutionNote || undefined,
        }),
      });
      setNotice("问题状态已更新");
      await Promise.all([openCase(caseDetail.id), loadOverview()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "问题更新失败");
    } finally {
      setWorking(false);
    }
  }

  function createFromCase() {
    if (!caseDetail) return;
    const suggested = caseDetail.items.find((item) => item.suggested_correction)?.suggested_correction;
    const citations = caseDetail.evidence?.citations ?? [];
    setEditor({
      ...emptyEditor(),
      sourceCaseId: caseDetail.id,
      question: caseDetail.canonical_question,
      answer: suggested ?? "",
      requiredKbIds: caseDetail.kb_ids,
      sources: citations.map((citation) => ({
        kb_id: null,
        doc_id: citation.doc_id,
        chunk_id: citation.chunk_id,
        source_title: citation.doc_title,
        quote: citation.quote,
        page_range: citation.page_range,
      })),
    });
  }

  async function saveCorrection() {
    if (!editor || editor.question.trim() === "" || editor.answer.trim() === "") {
      setError("标准问题和答案不能为空");
      return;
    }
    setWorking(true);
    setError("");
    try {
      const body = JSON.stringify({
        source_case_id: editor.sourceCaseId,
        canonical_question: editor.question,
        answer_markdown: editor.answer,
        aliases: editor.aliases.split("\n").map((item) => item.trim()).filter(Boolean),
        change_note: editor.changeNote || null,
        valid_until: editor.validUntil ? new Date(`${editor.validUntil}T23:59:59`).toISOString() : null,
        required_kb_ids: editor.requiredKbIds,
        sources: editor.sources,
      });
      const saved = await fetchJson<CorrectionDetail>(
        editor.id ? `/api/admin/answer-corrections/${editor.id}` : "/api/admin/answer-corrections",
        { method: editor.id ? "PATCH" : "POST", body }
      );
      setNotice(editor.id ? "标准答案新版本已保存为草稿" : "标准答案草稿已创建");
      await loadOverview();
      await openCorrection(saved.id);
      setTab("corrections");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "标准答案保存失败");
    } finally {
      setWorking(false);
    }
  }

  async function publishCorrection() {
    if (!editor?.id) return;
    setWorking(true);
    setError("");
    try {
      await fetchJson(`/api/admin/answer-corrections/${editor.id}/publish`, { method: "POST" });
      setNotice("标准答案已发布，后续匹配问题将直接使用该答案");
      await Promise.all([openCorrection(editor.id), loadOverview()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "标准答案发布失败");
    } finally {
      setWorking(false);
    }
  }

  async function archiveCorrection() {
    if (!editor?.id) return;
    setWorking(true);
    setError("");
    try {
      await fetchJson(`/api/admin/answer-corrections/${editor.id}/archive`, { method: "POST" });
      setNotice("标准答案已归档，不再参与匹配");
      await Promise.all([openCorrection(editor.id), loadOverview()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "标准答案归档失败");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <Topbar title="答案治理" subtitle="把真实用户反馈转成可审计、可回滚的租户标准答案">
        <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void loadOverview()}>
          刷新
        </Button>
      </Topbar>

      <div className={`dm-admin-content ${styles.page}`}>
        {error ? <div className={styles.error}><CircleAlert size={16} />{error}</div> : null}
        {notice ? <div className={styles.notice}><BadgeCheck size={16} />{notice}</div> : null}

        <section className={styles.metrics} aria-label="答案质量概览">
          <div className={styles.metric}>
            <span><CircleAlert size={15} />待处理问题</span>
            <strong>{summary?.pending_cases ?? "—"}</strong>
            <small>仍有有效差评的问题簇</small>
          </div>
          <div className={styles.metric}>
            <span><BadgeCheck size={15} />已发布标准答案</span>
            <strong>{summary?.published_corrections ?? "—"}</strong>
            <small>{summary?.needs_review ?? 0} 条待复核</small>
          </div>
          <div className={styles.metric}>
            <span><ThumbsDown size={15} />近 7 天差评率</span>
            <strong>{summary ? `${(summary.downvote_rate * 100).toFixed(1)}%` : "—"}</strong>
            <small>基于已评价回答</small>
          </div>
          <div className={styles.metric}>
            <span><Users size={15} />反馈覆盖率</span>
            <strong>{summary ? `${(summary.feedback_coverage * 100).toFixed(1)}%` : "—"}</strong>
            <small>近 7 天回答中已评价占比</small>
          </div>
        </section>

        <div className={styles.toolbar}>
          <Segmented options={tabs} value={tab} onChange={(value) => {
            setTab(value);
            setQuery("");
            setCaseDetail(null);
            setCorrectionDetail(null);
            setEditor(null);
          }} />
          <SearchInput
            placeholder={tab === "cases" ? "搜索问题..." : "搜索标准问题或答案..."}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {tab === "corrections" ? (
            <Button icon={<Sparkles size={15} />} onClick={() => {
              setCorrectionDetail(null);
              setEditor(emptyEditor());
            }}>
              新建标准答案
            </Button>
          ) : null}
        </div>

        {tab === "cases" ? (
          <div className={styles.workspace}>
            <Panel
              className={styles.listPanel}
              title="质量问题"
              action={<span>{visibleCases.length} 个问题簇</span>}
            >
              <div className={styles.list}>
                {visibleCases.map((item) => (
                  <button
                    className={`${styles.listRow} ${caseDetail?.id === item.id ? styles.selected : ""}`}
                    key={item.id}
                    onClick={() => void openCase(item.id)}
                    type="button"
                  >
                    <div>
                      <strong>{item.canonical_question}</strong>
                      <span>{readableDate(item.last_seen_at)} · {item.total_reports} 次反馈</span>
                    </div>
                    <div className={styles.rowMeta}>
                      <Badge tone={caseTone(item.status)}>{caseStatusLabels[item.status]}</Badge>
                      <b>{item.active_downvotes}</b>
                      <ChevronRight size={16} />
                    </div>
                  </button>
                ))}
                {!loading && visibleCases.length === 0 ? (
                  <div className={styles.empty}>没有符合条件的质量问题</div>
                ) : null}
              </div>
            </Panel>

            {caseDetail ? (
              <Panel className={styles.detailPanel}>
                <div className={styles.detailHead}>
                  <div>
                    <span className={styles.eyebrow}>问题簇 · {caseDetail.affected_users} 位用户</span>
                    <h2>{caseDetail.canonical_question}</h2>
                  </div>
                  <button aria-label="关闭详情" onClick={() => setCaseDetail(null)} type="button"><X size={18} /></button>
                </div>

                <div className={styles.detailActions}>
                  <Button variant="secondary" icon={<SearchCheck size={15} />} disabled={working} onClick={() => void diagnose()}>
                    自动诊断
                  </Button>
                  <Button icon={<BadgeCheck size={15} />} onClick={createFromCase}>
                    创建标准答案
                  </Button>
                </div>

                <div className={styles.formGrid}>
                  <label>根因
                    <select value={rootCause} onChange={(event) => setRootCause(event.target.value as RootCause | "")}>
                      <option value="">待判断</option>
                      {Object.entries(rootCauseLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label>处理状态
                    <select value={caseStatus} onChange={(event) => setCaseStatus(event.target.value as CaseStatus)}>
                      {Object.entries(caseStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label className={styles.full}>处理备注
                    <textarea value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} placeholder="记录判断和后续动作" rows={2} />
                  </label>
                </div>
                <Button variant="secondary" disabled={working} onClick={() => void saveCase()}>保存处理状态</Button>

                {caseDetail.suggested_cause ? (
                  <div className={styles.diagnosis}>
                    <Sparkles size={16} />
                    <div><strong>系统建议：{rootCauseLabels[caseDetail.suggested_cause]}</strong><p>{String(caseDetail.diagnostic_snapshot.reason ?? "已根据召回、重排和引用记录生成建议。")}</p></div>
                  </div>
                ) : null}

                <section className={styles.section}>
                  <h3>用户反馈</h3>
                  {caseDetail.items.map((item) => (
                    <article className={styles.feedbackCard} key={item.id}>
                      <header><strong>{item.user_name}</strong><span>{readableDate(item.updated_at)}</span>{!item.active ? <Badge>已撤回</Badge> : null}</header>
                      <p>{item.comment || "用户未填写补充说明"}</p>
                      {item.reason ? <small>症状：{item.reason}</small> : null}
                      {item.suggested_correction ? <blockquote><b>建议答案</b>{item.suggested_correction}</blockquote> : null}
                    </article>
                  ))}
                </section>

                {caseDetail.evidence ? (
                  <section className={styles.section}>
                    <h3>原回答与证据</h3>
                    <div className={styles.answerPreview}>{caseDetail.evidence.answer || "无回答内容"}</div>
                    <div className={styles.evidenceStats}>
                      <span>{caseDetail.evidence.retrieval_traces?.length ?? 0} 条召回记录</span>
                      <span>{caseDetail.evidence.citations?.length ?? 0} 条最终引用</span>
                    </div>
                  </section>
                ) : null}

                {editor ? <CorrectionForm editor={editor} setEditor={setEditor} working={working} onSave={saveCorrection} /> : null}
              </Panel>
            ) : (
              <div className={styles.blankDetail}><SearchCheck size={28} /><strong>选择一个问题查看完整证据</strong><span>反馈、原回答、召回轨迹和引用会汇总在这里</span></div>
            )}
          </div>
        ) : (
          <div className={styles.workspace}>
            <Panel className={styles.listPanel} title="标准答案" action={<span>{visibleCorrections.length} 条</span>}>
              <div className={styles.list}>
                {visibleCorrections.map((item) => (
                  <button
                    className={`${styles.listRow} ${correctionDetail?.id === item.id ? styles.selected : ""}`}
                    key={item.id}
                    onClick={() => void openCorrection(item.id)}
                    type="button"
                  >
                    <div>
                      <strong>{item.canonical_question}</strong>
                      <span>v{item.latest_version} · 命中 {item.hit_count} 次 · {readableDate(item.updated_at)}</span>
                    </div>
                    <div className={styles.rowMeta}>
                      <Badge tone={correctionTone(item.status)}>{correctionStatusLabels[item.status]}</Badge>
                      <ChevronRight size={16} />
                    </div>
                  </button>
                ))}
                {!loading && visibleCorrections.length === 0 ? <div className={styles.empty}>还没有标准答案</div> : null}
              </div>
            </Panel>

            {editor ? (
              <Panel className={styles.detailPanel}>
                <div className={styles.detailHead}>
                  <div>
                    <span className={styles.eyebrow}>{editor.id ? `标准答案 · v${correctionDetail?.latest_version ?? 1}` : "新建标准答案"}</span>
                    <h2>{editor.question || "填写标准问题与答案"}</h2>
                  </div>
                  <button aria-label="关闭编辑器" onClick={() => { setEditor(null); setCorrectionDetail(null); }} type="button"><X size={18} /></button>
                </div>
                {correctionDetail ? (
                  <div className={styles.correctionMeta}>
                    <Badge tone={correctionTone(correctionDetail.status)}>{correctionStatusLabels[correctionDetail.status]}</Badge>
                    <span>累计命中 {correctionDetail.hit_count} 次</span>
                    <span>索引状态：{correctionDetail.index_status}</span>
                  </div>
                ) : null}
                <CorrectionForm editor={editor} setEditor={setEditor} working={working} onSave={saveCorrection} />
                {editor.id && correctionDetail?.status !== "archived" ? (
                  <div className={styles.publishBar}>
                    <Button icon={<BadgeCheck size={15} />} disabled={working || !correctionDetail?.draft_version_id} onClick={() => void publishCorrection()}>
                      {correctionDetail?.published_version_id ? "发布新版本" : "发布标准答案"}
                    </Button>
                    <Button variant="ghost" icon={<Archive size={15} />} disabled={working} onClick={() => void archiveCorrection()}>
                      归档
                    </Button>
                  </div>
                ) : null}
              </Panel>
            ) : (
              <div className={styles.blankDetail}><BadgeCheck size={28} /><strong>选择或新建一条标准答案</strong><span>只有发布后的答案才会绕过检索并直接命中</span></div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function CorrectionForm({
  editor,
  setEditor,
  working,
  onSave,
}: {
  editor: CorrectionEditor;
  setEditor: (editor: CorrectionEditor | null) => void;
  working: boolean;
  onSave: () => void;
}) {
  return (
    <section className={styles.editor}>
      <div className={styles.editorTitle}><BadgeCheck size={17} /><strong>标准答案草稿</strong><span>保存后需发布才会生效</span></div>
      <label>标准问题
        <input value={editor.question} onChange={(event) => setEditor({ ...editor, question: event.target.value })} placeholder="用于管理和默认精确匹配" />
      </label>
      <label>等价问法 <small>每行一个，发布时一并参与匹配</small>
        <textarea value={editor.aliases} onChange={(event) => setEditor({ ...editor, aliases: event.target.value })} placeholder={"例如：\n如何申请年假？\n年假审批流程是什么？"} rows={3} />
      </label>
      <label>标准答案
        <textarea className={styles.answerEditor} value={editor.answer} onChange={(event) => setEditor({ ...editor, answer: event.target.value })} placeholder="支持 Markdown；应写出明确结论、步骤和适用边界" rows={9} />
      </label>
      <div className={styles.formGrid}>
        <label>有效期 <small>留空表示长期有效</small>
          <input type="date" value={editor.validUntil} onChange={(event) => setEditor({ ...editor, validUntil: event.target.value })} />
        </label>
        <label>版本说明
          <input value={editor.changeNote} onChange={(event) => setEditor({ ...editor, changeNote: event.target.value })} placeholder="本次修改原因" />
        </label>
      </div>
      <div className={styles.editorFoot}>
        <span>{editor.requiredKbIds.length > 0 ? `限定 ${editor.requiredKbIds.length} 个知识库` : "对租户全部知识库生效"} · {editor.sources.length} 条来源锚点</span>
        <Button disabled={working} onClick={() => void onSave()}>{editor.id ? "保存新版本" : "保存草稿"}</Button>
      </div>
    </section>
  );
}
