"use client";

import { useEffect, useRef } from "react";
import { FileText, Loader2 } from "lucide-react";
import type { ChatFile } from "@/lib/types";
import { fileExtLabel, formatFileSize } from "./chat-file-card";

export interface MentionFileGroup {
  key: "personal" | "space";
  title: string;
  files: ChatFile[];
}

interface FileMentionPickerProps {
  groups: MentionFileGroup[];
  query: string;
  status: "idle" | "loading" | "ready" | "failed";
  selectedIndex: number;
  onSelect: (file: ChatFile) => void;
  onHover: (index: number) => void;
}

/** 输入框 @ 触发的文件选择器。键盘事件由输入框统一处理，这里只负责展示。 */
export function FileMentionPicker({
  groups,
  query,
  status,
  selectedIndex,
  onSelect,
  onHover,
}: FileMentionPickerProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const total = groups.reduce((sum, group) => sum + group.files.length, 0);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  let flatIndex = -1;

  return (
    <div className="dm-composer-mention" ref={listRef} role="listbox" aria-label="引用文件">
      <div className="dm-composer-mention-heading">
        <span>引用文件</span>
        {query ? <em>· {query}</em> : null}
        {status === "loading" ? <Loader2 className="dm-composer-mention-spinner" size={13} aria-hidden="true" /> : null}
      </div>

      {status === "failed" ? (
        <div className="dm-composer-mention-empty" role="alert">
          文件列表加载失败，继续输入可正常发送消息。
        </div>
      ) : null}

      {status !== "failed" && status !== "loading" && total === 0 ? (
        <div className="dm-composer-mention-empty">没有匹配的文件</div>
      ) : null}

      {status === "loading" && total === 0 ? (
        <div className="dm-composer-mention-empty">正在加载文件…</div>
      ) : null}

      {groups.map((group) => {
        if (group.files.length === 0) return null;
        return (
          <div key={group.key}>
            <div className="dm-composer-mention-group-title">{group.title}</div>
            {group.files.map((file) => {
              flatIndex += 1;
              const index = flatIndex;
              return (
                <div
                  aria-selected={index === selectedIndex}
                  className={`dm-composer-mention-option${index === selectedIndex ? " selected" : ""}`}
                  data-mention-index={index}
                  key={`${group.key}:${file.id}`}
                  onClick={() => onSelect(file)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onHover(index)}
                  role="option"
                >
                  <span className="dm-conversation-file-icon" aria-hidden="true">
                    <FileText size={15} />
                    <small>{fileExtLabel(file)}</small>
                  </span>
                  <span className="dm-composer-mention-name" title={file.name}>
                    {file.name}
                  </span>
                  {file.size_bytes > 0 ? (
                    <span className="dm-composer-mention-size">{formatFileSize(file.size_bytes)}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}

      <div className="dm-composer-mention-footer">
        <span>↑↓ 选择</span>
        <span>Enter 引用</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  );
}
