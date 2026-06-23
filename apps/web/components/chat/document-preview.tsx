"use client";

import { FileText, Presentation, File, Navigation } from "lucide-react";
import type { Citation } from "@/lib/types";

interface DocumentPreviewProps {
  citation: Citation;
}

function detectDocType(title: string): "word" | "ppt" | "pdf" {
  const lower = title.toLowerCase();
  if (lower.endsWith(".pptx") || lower.endsWith(".ppt")) return "ppt";
  if (lower.endsWith(".pdf")) return "pdf";
  return "word";
}

function Toolbar({ icon: Icon, title }: { icon: typeof FileText; title: string }) {
  return (
    <div className="dm-doc-preview-toolbar">
      <Icon size={14} />
      <span>{title}</span>
    </div>
  );
}

function PageFooter({ page, total }: { page: number; total: number }) {
  return (
    <div className="dm-doc-preview-footer">
      第 {page} 页 / 共 {total} 页
    </div>
  );
}

function Highlight({ children }: { children: React.ReactNode }) {
  return <div className="dm-doc-preview-highlight">{children}</div>;
}

function WordPreview({ citation }: { citation: Citation }) {
  const page = citation.page_range[0] ?? 3;
  return (
    <div className="dm-doc-preview-frame">
      <Toolbar icon={FileText} title={citation.doc_title} />
      <div className="dm-doc-preview-body">
        <div className="dm-doc-preview-page dm-doc-preview-page-word">
          <h2>2025 年度销售策略</h2>
          <h3>Q1 季度目标与执行计划</h3>
          <div className="dm-doc-preview-divider" />
          <h4>一、总体目标</h4>
          <p>
            2025 年第一季度，公司整体销售目标为 2,180 万元，较去年同期增长 13.5%。其中华东区域作为核心市场，承担 55% 的销售任务。
          </p>
          <Highlight>
            {citation.quote ||
              "Q1 华东区域销售目标为 1200 万元，较去年同期增长 15%，其中新客户占比不低于 30%。华南区域目标为 980 万元，较去年同期增长 12%。"}
          </Highlight>
          <h4>二、区域分解</h4>
          <p>
            华东区域重点拓展智能制造与金融科技行业客户，华南区域聚焦消费品与医疗健康板块。各区域需在 3 月底前完成客户拜访计划并报备。
          </p>
          <h4>三、考核指标</h4>
          <p>
            新客户占比作为季度考核关键指标，权重为 20%。华东区域要求新客户占比不低于 30%，华南区域不低于 25%。
          </p>
        </div>
      </div>
      <PageFooter page={page} total={12} />
    </div>
  );
}

function PPTPreview({ citation }: { citation: Citation }) {
  const page = citation.page_range[0] ?? 2;
  return (
    <div className="dm-doc-preview-frame">
      <Toolbar icon={Presentation} title={citation.doc_title} />
      <div className="dm-doc-preview-body">
        <div className="dm-doc-preview-slide">
          <h2>2025 Q1 销售目标</h2>
          <Highlight>
            <h4>华东区域目标</h4>
            <p>
              {citation.quote ||
                "Q1 销售目标 1,200 万元，同比增长 15%，新客户占比 ≥ 30%。"}
            </p>
          </Highlight>
          <ul className="dm-doc-preview-bullets">
            <li>华南区域目标 980 万元，同比增长 12%</li>
            <li>聚焦行业：智能制造、金融科技、医疗健康</li>
            <li>关键节点：3 月底前完成客户拜访计划</li>
          </ul>
        </div>
        <div className="dm-doc-preview-thumbnails">
          <div className="dm-doc-preview-thumb" />
          <div className="dm-doc-preview-thumb active" />
          <div className="dm-doc-preview-thumb" />
          <div className="dm-doc-preview-thumb" />
        </div>
      </div>
      <PageFooter page={page} total={8} />
    </div>
  );
}

function PDFPreview({ citation }: { citation: Citation }) {
  const page = citation.page_range[0] ?? 1;
  return (
    <div className="dm-doc-preview-frame">
      <Toolbar icon={File} title={citation.doc_title} />
      <div className="dm-doc-preview-body">
        <div className="dm-doc-preview-page dm-doc-preview-page-pdf">
          <h2>2025 年度销售策略</h2>
          <h3>第一章：总体目标</h3>
          <p>
            本年度销售目标设定为 2,180 万元，同比增长 13.5%。公司将围绕华东、华南两大核心区域展开深度布局，并持续优化客户结构。
          </p>
          <Highlight>
            {citation.quote ||
              "华东区域 Q1 目标为 1,200 万元，同比增长 15%，新客户占比不低于 30%；华南区域 Q1 目标为 980 万元，同比增长 12%。"}
          </Highlight>
          <p>各区域需在每季度末提交销售复盘报告，并将新客户转化率作为核心考核指标之一。</p>
        </div>
        <div className="dm-doc-preview-page dm-doc-preview-page-pdf dm-doc-preview-page-peek">
          <h3>第二章：区域策略</h3>
          <p>华东区域重点行业为智能制造与金融科技，华南区域聚焦消费品与医疗健康……</p>
        </div>
      </div>
      <PageFooter page={page} total={6} />
    </div>
  );
}

export function DocumentPreview({ citation }: DocumentPreviewProps) {
  const type = detectDocType(citation.doc_title);
  const page = citation.page_range[0] ?? 1;

  return (
    <div className="dm-doc-preview-wrapper">
      {type === "word" && <WordPreview citation={citation} />}
      {type === "ppt" && <PPTPreview citation={citation} />}
      {type === "pdf" && <PDFPreview citation={citation} />}
      <div className="dm-doc-preview-locate">
        <Navigation size={12} />
        <span>已自动定位到第 {page} 页引用片段</span>
      </div>
    </div>
  );
}
