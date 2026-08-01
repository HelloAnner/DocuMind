"use client";

import { useEffect, useState } from "react";
import { getAdminDocument, type AdminDocumentDetail } from "@/lib/api";
import { DocumentDrawer } from "@/components/ui/document-drawer";

export function ManagedDocumentDrawer({
  docId,
  onClose,
  onNotice,
}: {
  docId: string;
  onClose: () => void;
  onNotice: (tone: "info" | "error", message: string) => void;
}) {
  const [detail, setDetail] = useState<AdminDocumentDetail>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAdminDocument(docId)
      .then((nextDetail) => {
        if (!cancelled) setDetail(nextDetail);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          onNotice("error", error instanceof Error ? error.message : "文档详情加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [docId, onNotice]);

  return <DocumentDrawer detail={detail} loading={loading} onClose={onClose} />;
}
