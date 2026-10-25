// 剪贴板图片：截图在浏览器里通常叫 image.png 或没有名字，这里统一成可读时间名。

const GENERIC_NAME = /^(image|blob|clipboard|pasted|粘贴图片)(\.(png|jpe?g|gif|webp))?$/i;
const PASTE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 粘贴进来的图片换成时间名，避免文件面板里一堆同名 image.png。 */
export function pastedFileName(file: File, at = Date.now()): string {
  if (file.name && !GENERIC_NAME.test(file.name)) return file.name;
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ext = PASTE_EXT[file.type.toLowerCase()] ?? (file.name.split(".").pop() || "png");
  return `粘贴图片-${stamp}.${ext}`;
}

/** 从 clipboardData 取文件：优先 files，退回 items（部分浏览器只给 items）。 */
export function clipboardFiles(data: Pick<DataTransfer, "files" | "items"> | null | undefined): File[] {
  if (!data) return [];
  if (data.files && data.files.length > 0) return Array.from(data.files);
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** 重命名为可读名字，同时保持浏览器推定的 MIME。 */
export function renamePastedFile(file: File): File {
  const name = pastedFileName(file);
  return name === file.name ? file : new File([file], name, { type: file.type });
}
