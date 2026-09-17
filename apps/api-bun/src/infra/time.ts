// 时间工具：与 chrono/serde RFC3339 输出保持一致（毫秒为 0 时不带 .000）
export function toRfc3339(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/\.000Z$/, 'Z');
}
export function nowRfc3339(): string {
  return toRfc3339(new Date());
}
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
