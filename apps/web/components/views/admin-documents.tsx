"use client";

import { useState } from "react";
import { FileText, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentDrawer } from "@/components/ui/document-drawer";
import { DocumentRow } from "@/components/ui/document-row";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { Topbar } from "@/components/ui/topbar";

const filters = [
  { value: "all", label: "全部" },
  { value: "done", label: "已完成" },
  { value: "parsing", label: "解析中" },
] as const;

const documents = [
  { name: "2025年度销售策略.pptx", type: "PPTX", size: "2.4 MB", chunks: 47, status: "已完成" as const, updated: "2025-06-10" },
  { name: "Q3 采购合同模板.docx", type: "DOCX", size: "856 KB", chunks: 12, status: "已完成" as const, updated: "2025-06-09" },
  { name: "员工报销政策 2025.pdf", type: "PDF", size: "1.2 MB", chunks: 28, status: "已完成" as const, updated: "2025-06-08" },
  { name: "产品安全规范 v2.1.pptx", type: "PPTX", size: "3.1 MB", chunks: 0, status: "解析中" as const, updated: "2025-06-08" },
  { name: "研发 API 文档 v3.0.docx", type: "DOCX", size: "2.8 MB", chunks: 34, status: "已完成" as const, updated: "2025-06-07" },
  { name: "市场推广方案.pdf", type: "PDF", size: "4.5 MB", chunks: 0, status: "失败" as const, updated: "2025-06-06" },
];

export function AdminDocuments() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filter, setFilter] = useState<typeof filters[number]["value"]>("all");

  const filtered = documents.filter((doc) => {
    if (filter === "done") return doc.status === "已完成";
    if (filter === "parsing") return doc.status === "解析中" || doc.status === "失败";
    return true;
  });

  return (
    <>
      <Topbar title="文档管理">
        <Button icon={<Upload size={14} />}>上传文档</Button>
      </Topbar>

      <div className="dm-admin-content">
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Panel title="上传文档">
            <div className="dm-upload-row">
              <div className="dm-drop-zone">
                <Upload size={28} />
                <strong>拖拽文件到此处，或点击选择文件</strong>
                <span>支持 Word / PPT / PDF，单个文件不超过 50MB</span>
              </div>
              <div className="dm-file-preview">
                <div className="dm-file-preview-head">
                  <FileText size={18} />
                  <span>
                    <strong>产品安全规范 v2.1.pptx</strong>
                    <small>3.1 MB · 等待上传</small>
                  </span>
                </div>
                <div className="dm-bar">
                  <span className="warning" style={{ width: "65%" }} />
                </div>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>解析中... 65%</span>
              </div>
            </div>
          </Panel>

          <Panel title="Documents" action={<Segmented options={filters} value={filter} onChange={setFilter} />}>
            <div className="dm-table-head" style={{ gridTemplateColumns: "minmax(260px, 1fr) 64px 64px 64px 86px 100px" }}>
              <span>文件名</span>
              <span>类型</span>
              <span>大小</span>
              <span>切片</span>
              <span>状态</span>
              <span>上传时间</span>
            </div>
            {filtered.map((doc) => (
              <DocumentRow key={doc.name} {...doc} onClick={() => setDrawerOpen(true)} />
            ))}
          </Panel>
        </div>
      </div>

      {drawerOpen && <DocumentDrawer onClose={() => setDrawerOpen(false)} />}
    </>
  );
}
