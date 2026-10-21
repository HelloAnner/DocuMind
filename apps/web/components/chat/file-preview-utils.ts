/**
 * 文件列表 / 输入框 @ 引用的纯逻辑。
 *
 * 这里刻意不依赖 React 和路径别名，方便用 node:test 直接做单元测试；
 * 组件层只负责渲染和网络请求。
 */

export type FilePreviewKind = "image" | "pdf" | "text" | "download";

export const MAX_TEXT_PREVIEW_BYTES = 200 * 1024;

interface PreviewFileShape {
  name: string;
  mime_type?: string;
  size_bytes?: number;
}

const RASTER_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "ico",
]);

const RASTER_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

const TEXT_EXTENSIONS = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "tex",
]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/csv",
]);

export function normalizeMimeType(mimeType: string | undefined): string {
  return (mimeType ?? "").split(";")[0].trim().toLowerCase();
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).trim().toLowerCase();
}

/**
 * 只把真正的栅格图片交给 <img>；SVG 故意不在此列，
 * 避免把可执行脚本的矢量文件当作图片打开。
 */
export function filePreviewKind(file: PreviewFileShape): FilePreviewKind {
  const mime = normalizeMimeType(file.mime_type);
  const extension = fileExtension(file.name);
  if (RASTER_IMAGE_MIME_TYPES.has(mime) || RASTER_IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    TEXT_MIME_TYPES.has(mime) ||
    TEXT_EXTENSIONS.has(extension)
  ) {
    return "text";
  }
  return "download";
}

export function isTextPreviewWithinLimit(byteLength: number): boolean {
  return Number.isFinite(byteLength) && byteLength >= 0 && byteLength <= MAX_TEXT_PREVIEW_BYTES;
}

export interface FileMentionTrigger {
  /** @ 之后输入的过滤词，可以为空。 */
  query: string;
  /** @ 在输入串中的位置。 */
  start: number;
  /** 触发词结束位置，等于输入串末尾。 */
  end: number;
}

/**
 * 输入框末尾的 @ 触发词。只在 @ 位于开头或空白之后时触发，
 * 因此邮箱（a@b）不会误打开文件选择器。
 */
export function findFileMention(input: string): FileMentionTrigger | null {
  if (!input) return null;
  const match = /(^|\s)@([^\s@]*)$/.exec(input);
  if (!match) return null;
  const query = match[2] ?? "";
  return {
    query,
    start: input.length - query.length - 1,
    end: input.length,
  };
}

/** 选中文件后把末尾的 @ 触发词移除，保留前面的正文。 */
export function removeFileMention(input: string): string {
  const trigger = findFileMention(input);
  if (!trigger) return input;
  return input.slice(0, trigger.start).replace(/\s+$/, "");
}

export function matchesFileQuery(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || name.toLowerCase().includes(needle);
}

/** 键盘上下移动选择项，边界处停住而不是循环。 */
export function nextMentionIndex(current: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  if (delta > 0) return Math.min(current + 1, length - 1);
  if (delta < 0) return Math.max(current - 1, 0);
  return Math.min(Math.max(current, 0), length - 1);
}
