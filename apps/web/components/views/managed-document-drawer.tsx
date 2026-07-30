"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  EyeOff,
  FolderInput,
  Replace,
  ScanLine,
  Trash2,
} from "lucide-react";
import {
  deleteAdminDocument,
  downloadAdminDocumentOriginal,
  excludeAdminDocumentFromSearch,
  forceIndexAdminDocument,
  getAdminDocument,
  moveAdminDocument,
  replaceAdminDocumentFile,
  retryAdminDocument,
  sendAdminDocumentToOcr,
  type AdminDocumentDetail,
  type KnowledgeBase,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DocumentDrawer } from "@/components/ui/document-drawer";

export function ManagedDocumentDrawer({
  docId,
  knowledgeBases,
  onClose,
  onChanged,
  onNotice,
}: {
  docId: string;
  knowledgeBases: KnowledgeBase[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onNotice: (tone: "info" | "error", message: string) => void;
}) {
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<AdminDocumentDetail>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [targetKbId, setTargetKbId] = useState("");

  const refreshDetail = useCallback(async () => {
    setLoading(true);
    try {
      const nextDetail = await getAdminDocument(docId);
      setDetail(nextDetail);
      setTargetKbId((current) => {
        if (current && current !== nextDetail.document.kb_id) return current;
        return knowledgeBases.find((kb) => kb.id !== nextDetail.document.kb_id)?.id ?? "";
      });
    } catch (error) {
      onNotice("error", error instanceof Error ? error.message : "文档详情加载失败");
    } finally {
      setLoading(false);
    }
  }, [docId, knowledgeBases, onNotice]);

  useEffect(() => {
    refreshDetail().catch(console.error);
  }, [refreshDetail]);

  async function runAction(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    try {
      await action();
      await Promise.all([refreshDetail(), Promise.resolve(onChanged())]);
      onNotice("info", successMessage);
    } catch (error) {
      onNotice("error", error instanceof Error ? error.message : "文档操作失败");
    } finally {
      setBusy(false);
    }
  }

  const doc = detail?.document;
  const canForceIndex = doc?.parse_status === "parse_low_confidence" && doc.chunk_count > 0;
  const canSendToOcr = doc?.parse_status === "parse_low_confidence" && doc.file_type === "pdf";
  const canExclude =
    doc != null &&
    ["indexed", "parse_low_confidence", "parse_failed", "embedding_failed"].includes(doc.parse_status);
  const canReplace =
    doc != null &&
    [
      "indexed",
      "parse_low_confidence",
      "parse_failed",
      "embedding_failed",
      "excluded_from_search",
    ].includes(doc.parse_status);

  async function handleMove() {
    if (!doc || !targetKbId || targetKbId === doc.kb_id) return;
    setBusy(true);
    try {
      const target = knowledgeBases.find((kb) => kb.id === targetKbId);
      await moveAdminDocument(doc.doc_id, targetKbId);
      await Promise.resolve(onChanged());
      onNotice("info", `已将《${doc.file_name}》移动到${target ? `“${target.name}”` : "目标知识库"}`);
      onClose();
    } catch (error) {
      onNotice("error", error instanceof Error ? error.message : "移动文档失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!doc || !window.confirm(`删除《${doc.file_name}》及其切片和引用索引？`)) return;
    setBusy(true);
    try {
      await deleteAdminDocument(doc.doc_id);
      await Promise.resolve(onChanged());
      onNotice("info", `已删除 ${doc.file_name}`);
      onClose();
    } catch (error) {
      onNotice("error", error instanceof Error ? error.message : "删除文档失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload() {
    if (!doc) return;
    try {
      await downloadAdminDocumentOriginal(doc.doc_id, doc.file_name);
    } catch (error) {
      onNotice("error", error instanceof Error ? error.message : "下载原件失败");
    }
  }

  async function handleReplace(file: File | undefined) {
    if (!doc || !file) return;
    await runAction(
      () => replaceAdminDocumentFile(doc.doc_id, file),
      `已替换《${doc.file_name}》并创建新的解析任务`
    );
    if (replaceInputRef.current) replaceInputRef.current.value = "";
  }

  return (
    <>
      <DocumentDrawer
        detail={detail}
        loading={loading}
        onClose={onClose}
        onRetry={() => {
          if (!doc) return;
          runAction(() => retryAdminDocument(doc.doc_id), `已重新提交《${doc.file_name}》解析`).catch(console.error);
        }}
        actions={
          doc ? (
            <>
              <label className="dm-form-field">
                <span>移动到知识库</span>
                <select
                  disabled={busy || !targetKbId}
                  value={targetKbId}
                  onChange={(event) => setTargetKbId(event.target.value)}
                >
                  {knowledgeBases
                    .filter((kb) => kb.id !== doc.kb_id)
                    .map((kb) => (
                      <option key={kb.id} value={kb.id}>
                        {kb.name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="dm-drawer-action-row">
                <Button
                  disabled={busy || !targetKbId}
                  icon={<FolderInput size={14} />}
                  onClick={() => handleMove().catch(console.error)}
                  variant="secondary"
                >
                  移动
                </Button>
                <Button
                  disabled={busy}
                  icon={<Download size={14} />}
                  onClick={() => handleDownload().catch(console.error)}
                  variant="secondary"
                >
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
                    disabled={!canForceIndex || busy}
                    icon={<CheckCircle2 size={14} />}
                    onClick={() =>
                      runAction(
                        () => forceIndexAdminDocument(doc.doc_id),
                        `已确认索引《${doc.file_name}》`
                      ).catch(console.error)
                    }
                    variant="secondary"
                  >
                    确认索引
                  </Button>
                  <Button
                    disabled={!canSendToOcr || busy}
                    icon={<ScanLine size={14} />}
                    onClick={() =>
                      runAction(
                        () => sendAdminDocumentToOcr(doc.doc_id),
                        `已将《${doc.file_name}》送入 OCR 队列`
                      ).catch(console.error)
                    }
                    variant="secondary"
                  >
                    送 OCR
                  </Button>
                </div>
                <div className="dm-drawer-action-row">
                  <Button
                    disabled={!canExclude || busy}
                    icon={<EyeOff size={14} />}
                    onClick={() => {
                      if (!window.confirm(`保留《${doc.file_name}》但从检索索引中排除？`)) return;
                      runAction(
                        () => excludeAdminDocumentFromSearch(doc.doc_id),
                        `已将《${doc.file_name}》排除检索`
                      ).catch(console.error);
                    }}
                    variant="secondary"
                  >
                    排除检索
                  </Button>
                  <Button
                    disabled={!canReplace || busy}
                    icon={<Replace size={14} />}
                    onClick={() => replaceInputRef.current?.click()}
                    variant="secondary"
                  >
                    替换文件
                  </Button>
                </div>
              </div>
              <Button
                disabled={busy}
                icon={<Trash2 size={14} />}
                onClick={() => handleDelete().catch(console.error)}
                variant="ghost"
              >
                删除文档
              </Button>
            </>
          ) : null
        }
      />
      <input
        accept=".docx,.pptx,.pdf,.txt,.md,.markdown"
        hidden
        onChange={(event) => handleReplace(event.target.files?.[0]).catch(console.error)}
        ref={replaceInputRef}
        type="file"
      />
    </>
  );
}
