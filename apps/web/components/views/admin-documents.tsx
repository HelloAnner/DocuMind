"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, RefreshCw, Upload } from "lucide-react";
import {
  getAdminDocument,
  listAdminDocuments,
  listKnowledgeBases,
  retryAdminDocument,
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
import { Topbar } from "@/components/ui/topbar";

const filters = [
  { value: "all", label: "全部" },
  { value: "parsed", label: "已完成" },
  { value: "parsing", label: "解析中" },
  { value: "parse_failed", label: "失败" },
] as const;

export function AdminDocuments() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<AdminDocument[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [selectedKb, setSelectedKb] = useState("");
  const [selectedDocId, setSelectedDocId] = useState<string>();
  const [detail, setDetail] = useState<AdminDocumentDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState<typeof filters[number]["value"]>("all");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();

  const selectedKbId = selectedKb || knowledgeBases[0]?.id || "";
  const activeDocument = useMemo(
    () => documents.find((doc) => doc.doc_id === selectedDocId),
    [documents, selectedDocId]
  );

  const refresh = async () => {
    const [kbRows, docRows] = await Promise.all([
      listKnowledgeBases(),
      listAdminDocuments({ status: filter }),
    ]);
    setKnowledgeBases(kbRows);
    setDocuments(docRows);
    if (!selectedKb && kbRows[0]) setSelectedKb(kbRows[0].id);
  };

  useEffect(() => {
    refresh().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [filter]);

  useEffect(() => {
    if (!selectedDocId) return;
    setDetailLoading(true);
    getAdminDocument(selectedDocId)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDetailLoading(false));
  }, [selectedDocId]);

  const handleUpload = async (file?: File) => {
    if (!file || !selectedKbId) return;
    setUploading(true);
    setError(undefined);
    try {
      const created = await uploadAdminDocument(selectedKbId, file);
      await refresh();
      setSelectedDocId(created.doc_id);
      window.setTimeout(() => refresh().catch(console.error), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRetry = async () => {
    if (!selectedDocId) return;
    setError(undefined);
    await retryAdminDocument(selectedDocId);
    await refresh();
    const next = await getAdminDocument(selectedDocId);
    setDetail(next);
    window.setTimeout(() => refresh().catch(console.error), 1200);
  };

  return (
    <>
      <Topbar title="文档管理">
        <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => refresh().catch(console.error)}>
          刷新
        </Button>
        <Button icon={<Upload size={14} />} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? "上传中" : "上传文档"}
        </Button>
      </Topbar>

      <div className="dm-admin-content">
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Panel title="上传文档">
            <div className="dm-upload-row">
              <button className="dm-drop-zone" type="button" onClick={() => fileInputRef.current?.click()}>
                <Upload size={28} />
                <strong>{uploading ? "正在上传并创建解析任务" : "拖拽文件到此处，或点击选择文件"}</strong>
                <span>Word / PPT / PDF</span>
              </button>
              <div className="dm-file-preview">
                <div className="dm-file-preview-head">
                  <FileText size={18} />
                  <span>
                    <strong>{activeDocument?.file_name ?? "等待上传"}</strong>
                    <small>
                      {activeDocument
                        ? `${formatSize(activeDocument.file_size)} · ${statusLabel(activeDocument.parse_status)}`
                        : knowledgeBases.find((kb) => kb.id === selectedKbId)?.name ?? "请选择知识库"}
                    </small>
                  </span>
                </div>
                <select
                  className="dm-select"
                  value={selectedKbId}
                  onChange={(event) => setSelectedKb(event.target.value)}
                >
                  {knowledgeBases.map((kb) => (
                    <option key={kb.id} value={kb.id}>
                      {kb.name}
                    </option>
                  ))}
                </select>
                {error ? <div className="dm-inline-error">{error}</div> : null}
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".docx,.pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              hidden
              onChange={(event) => handleUpload(event.target.files?.[0])}
            />
          </Panel>

          <Panel title="Documents" action={<Segmented options={filters} value={filter} onChange={setFilter} />}>
            <div
              className="dm-table-head dm-document-table-head"
              style={{ gridTemplateColumns: "minmax(260px, 1fr) 64px 80px 64px 64px 70px 86px 100px" }}
            >
              <span>文件名</span>
              <span>类型</span>
              <span>大小</span>
              <span>切片</span>
              <span>表格</span>
              <span>质量</span>
              <span>状态</span>
              <span>上传时间</span>
            </div>
            {documents.map((doc) => (
              <DocumentRow
                key={doc.doc_id}
                name={doc.file_name}
                type={doc.file_type.toUpperCase()}
                size={formatSize(doc.file_size)}
                chunks={doc.chunk_count}
                tables={doc.table_count}
                quality={doc.quality_score}
                kbName={doc.kb_name}
                status={statusLabel(doc.parse_status)}
                updated={new Date(doc.uploaded_at).toLocaleDateString()}
                onClick={() => setSelectedDocId(doc.doc_id)}
              />
            ))}
            {documents.length === 0 ? <div className="dm-empty-state">暂无文档</div> : null}
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
          onRetry={handleRetry}
        />
      )}
    </>
  );
}
