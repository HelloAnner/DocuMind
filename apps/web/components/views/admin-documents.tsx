"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  EyeOff,
  FileText,
  FolderInput,
  RefreshCw,
  Replace,
  ScanLine,
  Trash2,
  Upload,
} from "lucide-react";
import {
  deleteAdminDocument,
  downloadAdminDocumentOriginal,
  excludeAdminDocumentFromSearch,
  forceIndexAdminDocument,
  getAdminDocument,
  listAdminDocuments,
  listAdminKnowledgeBases,
  moveAdminDocument,
  replaceAdminDocumentFile,
  retryAdminDocument,
  retryAdminDocuments,
  sendAdminDocumentToOcr,
  uploadAdminDocument,
  type AdminDocument,
  type AdminDocumentDetail,
  type KnowledgeBase,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DocumentDrawer, formatSize, statusLabel } from "@/components/ui/document-drawer";
import { DocumentRow } from "@/components/ui/document-row";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";

const filters = [
  { value: "all", label: "全部" },
  { value: "done", label: "已完成" },
  { value: "parsing", label: "解析中" },
  { value: "failed", label: "失败" },
] as const;

type FilterValue = (typeof filters)[number]["value"];

type UploadState =
  | { state: "idle"; message: string }
  | { state: "ready"; message: string; file: File }
  | { state: "uploading"; message: string; file: File }
  | { state: "done"; message: string }
  | { state: "error"; message: string };

const statusParam = (filter: FilterValue): string | undefined => {
  if (filter === "done") return "done";
  if (filter === "failed") return "failed";
  return undefined;
};

const RETRYABLE_STATUSES = new Set([
  "parse_failed",
  "parse_low_confidence",
  "embedding_failed",
  "parsed",
  "parsing",
]);

export function AdminDocuments() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceFileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<AdminDocument[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [filterKb, setFilterKb] = useState("");
  const [uploadKbId, setUploadKbId] = useState("");
  const [selectedDocId, setSelectedDocId] = useState<string>();
  const [detail, setDetail] = useState<AdminDocumentDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [query, setQuery] = useState("");
  const [targetKbId, setTargetKbId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [replaceTargetDocId, setReplaceTargetDocId] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>({
    state: "idle",
    message: "选择 Word、PPT 或 PDF 后开始上传解析",
  });

  const activeDocument = useMemo(
    () => documents.find((doc) => doc.doc_id === selectedDocId),
    [documents, selectedDocId]
  );

  const refresh = async () => {
    const [kbRows, docRows] = await Promise.all([
      listAdminKnowledgeBases(),
      listAdminDocuments({
        kb_id: filterKb || undefined,
        status: statusParam(filter),
        q: query || undefined,
        limit: 200,
      }),
    ]);
    setKnowledgeBases(kbRows);
    setDocuments(docRows);
    setUploadKbId((current) => current || kbRows[0]?.id || "");
    setTargetKbId((current) => {
      if (current) return current;
      const activeKbId = activeDocument?.kb_id;
      return kbRows.find((kb) => kb.id !== activeKbId)?.id || kbRows[0]?.id || "";
    });
  };

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    refresh()
      .catch((error) => {
        console.error(error);
        if (mounted) {
          setUploadState({ state: "error", message: "文档列表加载失败" });
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [filter, filterKb, query]);

  useEffect(() => {
    if (!selectedDocId) return;
    setDetailLoading(true);
    getAdminDocument(selectedDocId)
      .then(setDetail)
      .catch((e) => {
        console.error(e);
        setUploadState({ state: "error", message: e instanceof Error ? e.message : "加载详情失败" });
      })
      .finally(() => setDetailLoading(false));
  }, [selectedDocId]);

  const selectedFile =
    uploadState.state === "ready" || uploadState.state === "uploading"
      ? uploadState.file
      : null;

  async function handleUpload() {
    if (!uploadKbId || !selectedFile || uploadState.state === "uploading") return;
    setUploadState({ state: "uploading", file: selectedFile, message: "上传并解析中..." });
    try {
      const created = await uploadAdminDocument(uploadKbId, selectedFile);
      await refresh();
      setUploadState({
        state: "done",
        message: `已创建 ${created.file_name}，解析任务 ${created.latest_parse_job_id?.slice(0, 8) ?? "—"}`,
      });
      setSelectedDocId(created.doc_id);
      if (fileInputRef.current) fileInputRef.current.value = "";
      window.setTimeout(() => refresh().catch(console.error), 1200);
    } catch (error) {
      console.error(error);
      setUploadState({
        state: "error",
        message: error instanceof Error ? error.message : "上传失败",
      });
    }
  }

  async function handleReprocess(doc: AdminDocument) {
    setBusyDocId(doc.doc_id);
    try {
      await retryAdminDocument(doc.doc_id);
      await refresh();
      setUploadState({
        state: "done",
        message: `已重新解析 ${doc.file_name}`,
      });
      window.setTimeout(() => refresh().catch(console.error), 1200);
    } catch (error) {
      console.error(error);
      setUploadState({
        state: "error",
        message: error instanceof Error ? error.message : "重解析失败",
      });
    } finally {
      setBusyDocId(null);
    }
  }

  async function refreshDocumentDetail(docId: string) {
    const nextDetail = await getAdminDocument(docId);
    setDetail(nextDetail);
    return nextDetail;
  }

  async function handleForceIndex() {
    const doc = detail?.document;
    if (!doc) return;
    setBusyDocId(doc.doc_id);
    try {
      await forceIndexAdminDocument(doc.doc_id);
      await refresh();
      await refreshDocumentDetail(doc.doc_id);
      setUploadState({ state: "done", message: `已确认索引 ${doc.file_name}` });
      window.setTimeout(() => refreshDocumentDetail(doc.doc_id).catch(console.error), 1200);
    } catch (error) {
      console.error(error);
      setUploadState({
        state: "error",
        message: error instanceof Error ? error.message : "强制索引失败",
      });
    } finally {
      setBusyDocId(null);
    }
  }

  async function handleSendToOcr() {
    const doc = detail?.document;
    if (!doc) return;
    setBusyDocId(doc.doc_id);
    try {
      const queued = await sendAdminDocumentToOcr(doc.doc_id);
      await refresh();
      await refreshDocumentDetail(doc.doc_id);
      setUploadState({
        state: "done",
        message: `已送入 OCR 队列 ${queued.ocr_job_id.slice(0, 8)}`,
      });
    } catch (error) {
      console.error(error);
      setUploadState({
        state: "error",
        message: error instanceof Error ? error.message : "送入 OCR 失败",
      });
    } finally {
      setBusyDocId(null);
    }
  }

  async function handleExcludeFromSearch() {
    const doc = detail?.document;
    if (!doc) return;
    const confirmed = window.confirm(`保留《${doc.file_name}》但从检索索引中排除？`);
    if (!confirmed) return;
    setBusyDocId(doc.doc_id);
    try {
      const excluded = await excludeAdminDocumentFromSearch(doc.doc_id);
      await refresh();
      await refreshDocumentDetail(doc.doc_id);
      setUploadState({
        state: "done",
        message: `已排除检索，删除 ${excluded.es_deleted_chunks} 个索引切片`,
      });
    } catch (error) {
      console.error(error);
      setUploadState({
        state: "error",
        message: error instanceof Error ? error.message : "排除检索失败",
      });
    } finally {
      setBusyDocId(null);
    }
  }

  function handleReplaceFile() {
    const doc = detail?.document;
    if (!doc) return;
    setReplaceTargetDocId(doc.doc_id);
    replaceFileInputRef.current?.click();
  }

  async function handleReplaceFileSelected(file: File | undefined) {
    const docId = replaceTargetDocId;
    if (!docId || !file) return;
    setBusyDocId(docId);
    try {
      const replaced = await replaceAdminDocumentFile(docId, file);
      await refresh();
      await refreshDocumentDetail(docId);
      setUploadState({
        state: "done",
        message: `已替换文件并创建解析任务 ${replaced.parse_job_id.slice(0, 8)}`,
      });
      window.setTimeout(() => refreshDocumentDetail(docId).catch(console.error), 1200);
    } catch (error) {
      console.error(error);
      setUploadState({
        state: "error",
        message: error instanceof Error ? error.message : "替换文件失败",
      });
    } finally {
      setBusyDocId(null);
      setReplaceTargetDocId(null);
      if (replaceFileInputRef.current) replaceFileInputRef.current.value = "";
    }
  }

  async function handleRetryFailed() {
    const failedIds = documents
      .filter((doc) => RETRYABLE_STATUSES.has(doc.parse_status))
      .map((doc) => doc.doc_id);
    if (failedIds.length === 0) return;
    try {
      await retryAdminDocuments(failedIds);
      await refresh();
      window.setTimeout(() => refresh().catch(console.error), 1200);
    } catch (error) {
      console.error(error);
      setUploadState({
        state: "error",
        message: error instanceof Error ? error.message : "批量重试失败",
      });
    }
  }

  async function handleDelete(doc?: AdminDocument) {
    const target = doc ?? detail?.document;
    if (!target) return;
    const confirmed = window.confirm(`删除《${target.file_name}》及其切片和引用索引？`);
    if (!confirmed) return;
    const docId = target.doc_id;
    setBusyDocId(docId);
    try {
      await deleteAdminDocument(docId);
      await refresh();
      if (!doc || doc.doc_id === selectedDocId) {
        setSelectedDocId(undefined);
        setDetail(undefined);
      }
      setUploadState({ state: "done", message: `已删除 ${target.file_name}` });
    } catch (error) {
      console.error(error);
      setUploadState({
        state: "error",
        message: error instanceof Error ? error.message : "删除失败",
      });
    } finally {
      setBusyDocId(null);
    }
  }

  async function handleMove() {
    if (!detail || !targetKbId || targetKbId === detail.document.kb_id) return;
    try {
      const moved = await moveAdminDocument(detail.document.doc_id, targetKbId);
      await refresh();
      setDetail(await getAdminDocument(moved.doc_id));
    } catch (error) {
      console.error(error);
      setUploadState({
        state: "error",
        message: error instanceof Error ? error.message : "移动失败",
      });
    }
  }

  async function handleDownload() {
    if (!detail) return;
    try {
      await downloadAdminDocumentOriginal(detail.document.doc_id, detail.document.file_name);
    } catch (error) {
      console.error(error);
      setUploadState({
        state: "error",
        message: error instanceof Error ? error.message : "下载失败",
      });
    }
  }

  const filtered = useMemo(() => {
    if (filter === "parsing") {
      return documents.filter((doc) => statusLabel(doc.parse_status) !== "已完成");
    }
    return documents;
  }, [documents, filter]);

  const drawerDoc = detail?.document;
  const drawerBusy = drawerDoc ? busyDocId === drawerDoc.doc_id : false;
  const canForceIndex =
    drawerDoc?.parse_status === "parse_low_confidence" && drawerDoc.chunk_count > 0;
  const canSendToOcr =
    drawerDoc?.parse_status === "parse_low_confidence" && drawerDoc.file_type === "pdf";
  const canExclude =
    drawerDoc != null &&
    ["indexed", "parse_low_confidence", "parse_failed", "embedding_failed"].includes(
      drawerDoc.parse_status
    );
  const canReplace =
    drawerDoc != null &&
    [
      "indexed",
      "parse_low_confidence",
      "parse_failed",
      "embedding_failed",
      "excluded_from_search",
    ].includes(drawerDoc.parse_status);

  return (
    <>
      <Topbar title="文档管理" subtitle="上传、解析、重跑并管理可检索文档">
        <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => refresh().catch(console.error)}>
          刷新
        </Button>
        <Button icon={<Upload size={14} />} onClick={() => fileInputRef.current?.click()}>
          上传文档
        </Button>
      </Topbar>

      <div className="dm-admin-content">
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Panel title="上传文档">
            <div className="dm-upload-row">
              <button
                className="dm-drop-zone"
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                <Upload size={28} />
                <strong>{selectedFile ? selectedFile.name : "选择文件上传并解析"}</strong>
                <span>支持 Word / PPT / PDF / TXT / Markdown，单个文件不超过 100MB</span>
              </button>

              <div className="dm-file-preview">
                <div className="dm-file-preview-head">
                  <FileText size={18} />
                  <span>
                    <strong>{activeDocument?.file_name ?? selectedFile?.name ?? "等待选择文件"}</strong>
                    <small>
                      {activeDocument
                        ? `${formatSize(activeDocument.file_size)} · ${statusLabel(activeDocument.parse_status)}`
                        : selectedFile
                        ? `${formatBytes(selectedFile.size)} · ${uploadState.message}`
                        : uploadState.message}
                    </small>
                  </span>
                </div>

                <div className="dm-upload-controls">
                  <label>
                    <span>知识库</span>
                    <select value={uploadKbId} onChange={(event) => setUploadKbId(event.target.value)}>
                      {knowledgeBases.map((kb) => (
                        <option key={kb.id} value={kb.id}>
                          {kb.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    disabled={!selectedFile || !uploadKbId || uploadState.state === "uploading"}
                    icon={<Upload size={14} />}
                    onClick={handleUpload}
                  >
                    {uploadState.state === "uploading" ? "处理中" : "上传解析"}
                  </Button>
                </div>

                <div className="dm-bar">
                  <span
                    className={uploadState.state === "error" ? "danger" : "success"}
                    style={{
                      width:
                        uploadState.state === "uploading"
                          ? "65%"
                          : uploadState.state === "done"
                          ? "100%"
                          : uploadState.state === "error"
                          ? "100%"
                          : selectedFile
                          ? "30%"
                          : "0%",
                    }}
                  />
                </div>
                <input
                  accept=".docx,.pptx,.pdf,.txt,.md"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      setUploadState({
                        state: "ready",
                        file,
                        message: `${formatBytes(file.size)} · 等待上传`,
                      });
                    }
                  }}
                  ref={fileInputRef}
                  type="file"
                />
                <input
                  accept=".docx,.pptx,.pdf,.txt,.md"
                  hidden
                  onChange={(event) => handleReplaceFileSelected(event.target.files?.[0])}
                  ref={replaceFileInputRef}
                  type="file"
                />
              </div>
            </div>
          </Panel>

          <Panel
            title="Documents"
            action={
              <div className="dm-document-panel-actions">
                <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => handleRetryFailed().catch(console.error)}>
                  重试异常
                </Button>
                <Segmented options={filters} value={filter} onChange={setFilter} />
              </div>
            }
          >
            <div className="dm-document-toolbar">
              <SearchInput placeholder="搜索文件名或标题..." value={query} onChange={(event) => setQuery(event.target.value)} />
              <select className="dm-select" value={filterKb} onChange={(event) => setFilterKb(event.target.value)}>
                <option value="">全部知识库</option>
                {knowledgeBases.map((kb) => (
                  <option key={kb.id} value={kb.id}>
                    {kb.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="dm-table-head dm-document-table-head">
              <span>文件名</span>
              <span>类型</span>
              <span>大小</span>
              <span>页数</span>
              <span>切片</span>
              <span>表格</span>
              <span>质量</span>
              <span>状态</span>
              <span>更新时间</span>
              <span>操作</span>
            </div>
            {loading ? <div className="dm-empty-state">加载文档中...</div> : null}
            {!loading && filtered.length === 0 ? <div className="dm-empty-state">暂无文档</div> : null}
            {!loading
              ? filtered.map((doc) => (
                  <DocumentRow
                    key={doc.doc_id}
                    name={doc.file_name}
                    type={doc.file_type.toUpperCase()}
                    size={formatSize(doc.file_size)}
                    pages={doc.page_count}
                    chunks={doc.chunk_count}
                    tables={doc.table_count}
                    quality={doc.quality_score}
                    kbName={doc.kb_name}
                    status={statusLabel(doc.parse_status)}
                    updated={new Date(doc.updated_at).toLocaleDateString()}
                    meta={`v${doc.parse_version} · ${doc.latest_parse_job_id?.slice(0, 8) ?? "no job"}`}
                    onClick={() => setSelectedDocId(doc.doc_id)}
                    actions={
                      <>
                        <button
                          className="dm-row-action"
                          disabled={busyDocId === doc.doc_id}
                          onClick={() => handleReprocess(doc)}
                          title="重解析"
                          type="button"
                        >
                          <RefreshCw size={14} />
                        </button>
                        <button
                          className="dm-row-action danger"
                          disabled={busyDocId === doc.doc_id}
                          onClick={() => handleDelete(doc)}
                          title="删除"
                          type="button"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    }
                  />
                ))
              : null}
          </Panel>
        </div>
      </div>

      {selectedDocId && (
        <DocumentDrawer
          detail={detail}
          loading={detailLoading}
          onClose={() => {
            setSelectedDocId(undefined);
            setDetail(undefined);
          }}
          onRetry={() => {
            if (!selectedDocId) return;
            retryAdminDocument(selectedDocId)
              .then(() => refresh())
              .then(() => getAdminDocument(selectedDocId))
              .then(setDetail)
              .catch(console.error);
          }}
          actions={
            <>
              <label className="dm-form-field">
                <span>移动到知识库</span>
                <select value={targetKbId} onChange={(event) => setTargetKbId(event.target.value)}>
                  {knowledgeBases.map((kb) => (
                    <option key={kb.id} value={kb.id}>
                      {kb.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="dm-drawer-action-row">
                <Button variant="secondary" icon={<FolderInput size={14} />} onClick={() => handleMove().catch(console.error)}>
                  移动
                </Button>
                <Button variant="secondary" icon={<Download size={14} />} onClick={() => handleDownload().catch(console.error)}>
                  下载原件
                </Button>
              </div>
              <div className="dm-manual-actions">
                <div className="dm-manual-actions-head">
                  <strong>人工处理</strong>
                  <span>低置信、失败或下线文档的明确处置</span>
                </div>
                <div className="dm-drawer-action-row">
                  <Button
                    disabled={!canForceIndex || drawerBusy}
                    icon={<CheckCircle2 size={14} />}
                    onClick={() => handleForceIndex().catch(console.error)}
                    variant="secondary"
                  >
                    确认索引
                  </Button>
                  <Button
                    disabled={!canSendToOcr || drawerBusy}
                    icon={<ScanLine size={14} />}
                    onClick={() => handleSendToOcr().catch(console.error)}
                    variant="secondary"
                  >
                    送 OCR
                  </Button>
                </div>
                <div className="dm-drawer-action-row">
                  <Button
                    disabled={!canExclude || drawerBusy}
                    icon={<EyeOff size={14} />}
                    onClick={() => handleExcludeFromSearch().catch(console.error)}
                    variant="secondary"
                  >
                    排除检索
                  </Button>
                  <Button
                    disabled={!canReplace || drawerBusy}
                    icon={<Replace size={14} />}
                    onClick={handleReplaceFile}
                    variant="secondary"
                  >
                    替换文件
                  </Button>
                </div>
              </div>
              <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => handleDelete().catch(console.error)}>
                删除文档
              </Button>
            </>
          }
        />
      )}
    </>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
