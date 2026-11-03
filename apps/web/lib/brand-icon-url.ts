// favicon 路径要能被 Server Component（layout 的 metadata.icons）读取，
// 所以单独放在无 "use client" 的模块里，不能从客户端组件导出。
export const BRAND_ICON_URL = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/favicon.svg?v=2`;
