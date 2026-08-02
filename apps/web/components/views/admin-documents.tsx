"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw, Trash2, Upload, X } from "lucide-react";
import {
  deleteAdminDocument,
  listAdminDocuments,
  listAdminKnowledgeBases,
  retryAdminDocument,
  retryAdminDocuments,
  type AdminDocument,
  type KnowledgeBase,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { formatSize, statusLabel } from "@/components/ui/document-drawer";
import { DocumentRow } from "@/components/ui/document-row";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Segmented } from "@/components/ui/segmented";
import { AdminDocumentUploadModal } from "./admin-document-upload-modal";
import { ManagedDocumentDrawer } from "./managed-document-drawer";

const filters = [
  { value: "all", label: "全部" },
  { value: "done", label: "已完成" },
  { value: "parsing", label: "解析中" },
  { value: "failed", label: "失败" },
] as const;

type FilterValue = (typeof filters)[number]["value"];
type Notice = { tone: "info" | "error"; message: string };

const PROCESSING_STATUSES = new Set(["uploaded", "parsing", "embedding", "ocr_pending"]);
const RETRYABLE_STATUSES = new Set(["parse_failed", "parse_low_confidence", "embedding_failed"]);

function statusParam(filter: FilterValue): string | undefined {
  if (filter === "done") return "done";
  if (filter === "failed") return "failed";
  return undefined;
}

export function AdminDocuments() {
  const requestId = useRef(0);
  const [paramsReady, setParamsReady] = useState(false);
  const [kbId, setKbId] = useState("");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<AdminDocument[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string>();
  const [filter, setFilter] = useState<FilterValue>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>();
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setKbId(params.get("kb_id") ?? "");
    setParamsReady(true);
  }, []);

  const refresh = useCallback(
    async (showLoading = false) => {
      if (!paramsReady || !kbId) {
        if (paramsReady) setLoading(false);
        return;
      }
      const currentRequest = ++requestId.current;
      if (showLoading) setLoading(true);
      try {
        const [kbRows, docRows] = await Promise.all([
          listAdminKnowledgeBases(),
          listAdminDocuments({
            kb_id: kbId,
            status: statusParam(filter),
            q: query.trim() || undefined,
            limit: 200,
          }),
        ]);
        if (requestId.current !== currentRequest) return;
        setKnowledgeBases(kbRows);
        setDocuments(docRows);
        setNotice((current) => (current?.tone === "error" ? undefined : current));
      } catch (error) {
        if (requestId.current !== currentRequest) return;
        setNotice({
          tone: "error",
          message: error instanceof Error ? error.message : "文档列表加载失败",
        });
      } finally {
        if (requestId.current === currentRequest) setLoading(false);
      }
    },
    [filter, kbId, paramsReady, query]
  );

  useEffect(() => {
    refresh(true).catch(console.error);
  }, [refresh]);

  const hasProcessingDocument = documents.some((doc) => PROCESSING_STATUSES.has(doc.parse_status));

  useEffect(() => {
    if (!hasProcessingDocument) return;
    const timer = window.setInterval(() => refresh().catch(console.error), 2500);
    return () => window.clearInterval(timer);
  }, [hasProcessingDocument, refresh]);

  const handleDrawerNotice = useCallback((tone: "info" | "error", message: string) => {
    setNotice({ tone, message });
  }, []);

  const knowledgeBase = knowledgeBases.find((kb) => kb.id === kbId);
  const visibleDocuments = useMemo(() => {
    if (filter !== "parsing") return documents;
    return documents.filter((doc) => PROCESSING_STATUSES.has(doc.parse_status));
  }, [documents, filter]);

  const allSelected = visibleDocuments.length > 0 && visibleDocuments.every((doc) => selectedDocIds.has(doc.doc_id));
  const someSelected = visibleDocuments.some((doc) => selectedDocIds.has(doc.doc_id));

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedDocIds(new Set());
    } else {
      setSelectedDocIds(new Set(visibleDocuments.map((doc) => doc.doc_id)));
    }
  }

  function toggleSelectDoc(docId: string, checked: boolean) {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(docId);
      } else {
        next.delete(docId);
      }
      return next;
    });
  }

  async function handleBatchDelete() {
    const selectedIds = Array.from(selectedDocIds);
    if (selectedIds.length === 0) return;
    if (!window.confirm(`确认永久删除选中的 ${selectedIds.length} 个文档、检索索引及引用过这些文档的历史会话？`)) return;
    setBatchBusy(true);
    setNotice(undefined);
    let deleted = 0;
    let failed = 0;
    for (const docId of selectedIds) {
      try {
        await deleteAdminDocument(docId);
        deleted++;
        if (selectedDocId === docId) setSelectedDocId(undefined);
      } catch {
        failed++;
      }
    }
    setSelectedDocIds(new Set());
    if (failed === 0) {
      setNotice({ tone: "info", message: `已删除 ${deleted} 个文档` });
    } else {
      setNotice({ tone: "error", message: `成功删除 ${deleted} 个，${failed} 个失败` });
    }
    setBatchBusy(false);
    await refresh();
  }

  async function handleBatchRetry() {
    const selectedIds = Array.from(selectedDocIds);
    if (selectedIds.length === 0) return;
    setBatchBusy(true);
    setNotice(undefined);
    try {
      await retryAdminDocuments(selectedIds);
      setNotice({ tone: "info", message: `已重新提交 ${selectedIds.length} 个文档解析` });
      setSelectedDocIds(new Set());
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "批量重试失败",
      });
    } finally {
      setBatchBusy(false);
      await refresh();
    }
  }

  async function handleReprocess(doc: AdminDocument) {
    setBusyDocId(doc.doc_id);
    setNotice(undefined);
    try {
      await retryAdminDocument(doc.doc_id);
      setNotice({ tone: "info", message: `已重新提交《${doc.file_name}》解析` });
      await refresh();
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "重新解析失败",
      });
    } finally {
      setBusyDocId(null);
    }
  }

  async function handleDelete(doc: AdminDocument) {
    if (!window.confirm(`永久删除《${doc.file_name}》、检索索引及引用过该文档的历史会话？`)) return;
    setBusyDocId(doc.doc_id);
    setNotice(undefined);
    try {
      await deleteAdminDocument(doc.doc_id);
      if (selectedDocId === doc.doc_id) setSelectedDocId(undefined);
      setNotice({ tone: "info", message: `已删除 ${doc.file_name}` });
      await refresh();
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "删除失败",
      });
    } finally {
      setBusyDocId(null);
    }
  }

  async function handleRetryFailed() {
    const failedIds = documents
      .filter((doc) => RETRYABLE_STATUSES.has(doc.parse_status))
      .map((doc) => doc.doc_id);
    if (failedIds.length === 0) {
      setNotice({ tone: "info", message: "当前没有可重试的异常文档" });
      return;
    }
    setNotice(undefined);
    try {
      await retryAdminDocuments(failedIds);
      setNotice({ tone: "info", message: `已重新提交 ${failedIds.length} 个异常文档` });
      await refresh();
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "批量重试失败",
      });
    }
  }

  return (
    <>
      <header className="dm-topbar dm-document-topbar">
        <div className="dm-document-title-row">
          <Link className="dm-document-back-link" href="/admin/knowledge">
            <ArrowLeft size={14} />
            知识库
          </Link>
          <span aria-hidden="true">/</span>
          <h1>{knowledgeBase?.name ?? "知识库文档"}</h1>
        </div>
        <div className="dm-topbar-actions">
          <Button
            aria-label="刷新文档列表"
            icon={<RefreshCw size={14} />}
            onClick={() => refresh(true).catch(console.error)}
            variant="secondary"
          >
            刷新
          </Button>
          {kbId ? (
            <Button icon={<Upload size={14} />} onClick={() => setShowUploadModal(true)}>
              上传文档
            </Button>
          ) : null}
        </div>
      </header>

      <div className="dm-admin-content">
        {!kbId && paramsReady ? (
          <Panel className="dm-route-empty-state">
            <strong>请先选择一个知识库</strong>
            <p>文档不再提供独立管理入口，请从知识库列表进入对应的文档空间。</p>
            <Link href="/admin/knowledge">
              <Button>返回知识库</Button>
            </Link>
          </Panel>
        ) : (
          <Panel
            className="dm-kb-document-panel"
            title={`文档列表 · ${visibleDocuments.length}`}
            action={
              <div className="dm-document-panel-actions">
                <Button
                  icon={<RefreshCw size={14} />}
                  onClick={() => handleRetryFailed().catch(console.error)}
                  variant="secondary"
                >
                  重试异常
                </Button>
                <Segmented options={filters} value={filter} onChange={setFilter} />
              </div>
            }
          >
            <div className="dm-document-toolbar">
              <SearchInput
                placeholder="搜索文件名或标题..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {notice ? (
              <div
                className={notice.tone === "error" ? "dm-inline-error" : "dm-inline-notice"}
                role={notice.tone === "error" ? "alert" : "status"}
              >
                {notice.message}
              </div>
            ) : null}

            <div className="dm-table-head dm-document-table-head">
              <span className="dm-document-checkbox">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={toggleSelectAll}
                  aria-label="全选"
                />
              </span>
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
            {!loading && visibleDocuments.length === 0 ? (
              <div className="dm-document-empty-state">
                <strong>{query ? "没有匹配的文档" : "这个知识库还没有文档"}</strong>
                <p>{query ? "请尝试其他关键词。" : "上传第一个文档后，解析状态会显示在这里。"}</p>
                {!query && kbId ? (
                  <Button icon={<Upload size={14} />} onClick={() => setShowUploadModal(true)}>
                    上传文档
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!loading
              ? visibleDocuments.map((doc) => (
                  <DocumentRow
                    key={doc.doc_id}
                    name={doc.file_name}
                    type={doc.file_type.toUpperCase()}
                    size={formatSize(doc.file_size)}
                    pages={doc.page_count}
                    chunks={doc.chunk_count}
                    tables={doc.table_count}
                    quality={doc.quality_score}
                    status={statusLabel(doc.parse_status)}
                    updated={new Date(doc.updated_at).toLocaleDateString()}
                    meta={`v${doc.parse_version} · ${doc.latest_parse_job_id?.slice(0, 8) ?? "no job"}`}
                    onClick={() => setSelectedDocId(doc.doc_id)}
                    selected={selectedDocIds.has(doc.doc_id)}
                    onSelect={(checked) => toggleSelectDoc(doc.doc_id, checked)}
                    actions={
                      <>
                        <button
                          aria-label={`重新解析 ${doc.file_name}`}
                          className="dm-row-action"
                          disabled={busyDocId === doc.doc_id}
                          onClick={() => handleReprocess(doc).catch(console.error)}
                          title="重解析"
                          type="button"
                        >
                          <RefreshCw size={14} />
                        </button>
                        <button
                          aria-label={`删除 ${doc.file_name}`}
                          className="dm-row-action danger"
                          disabled={busyDocId === doc.doc_id}
                          onClick={() => handleDelete(doc).catch(console.error)}
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
        )}
      </div>

      {selectedDocId ? (
        <ManagedDocumentDrawer
          key={selectedDocId}
          docId={selectedDocId}
          onClose={() => setSelectedDocId(undefined)}
          onNotice={handleDrawerNotice}
        />
      ) : null}

      {showUploadModal && kbId ? (
        <AdminDocumentUploadModal
          kbId={kbId}
          kbName={knowledgeBase?.name ?? "知识库"}
          onClose={() => setShowUploadModal(false)}
          onUploaded={() => refresh()}
        />
      ) : null}

      {selectedDocIds.size > 0 ? (
        <div className="dm-batch-action-bar" role="toolbar" aria-label="批量操作">
          <span className="dm-batch-action-count">已选择 {selectedDocIds.size} 个文档</span>
          <div className="dm-batch-action-buttons">
            <Button
              icon={<RefreshCw size={14} />}
              disabled={batchBusy}
              onClick={() => handleBatchRetry().catch(console.error)}
              variant="secondary"
            >
              批量重试
            </Button>
            <Button
              icon={<Trash2 size={14} />}
              disabled={batchBusy}
              onClick={() => handleBatchDelete().catch(console.error)}
              variant="secondary"
            >
              批量删除
            </Button>
            <Button
              icon={<X size={14} />}
              onClick={() => setSelectedDocIds(new Set())}
              variant="ghost"
            >
              取消选择
            </Button>
          </div>
        </div>
      ) : null}

      <span className="dm-screen-reader-only" aria-live="polite">
        {loading ? "正在加载文档" : `已显示 ${visibleDocuments.length} 个文档`}
      </span>
    </>
  );
}
