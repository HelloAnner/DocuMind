/** RFC 6266/5987: header values stay ASCII; the original name lives in filename*. */
export function contentDisposition(name: string, disposition: 'inline' | 'attachment' = 'attachment'): string {
  const cleaned = Array.from(name.toWellFormed())
    .filter(ch => ch !== '/' && ch !== '\\' && !/\p{Cc}/u.test(ch)).join('').trim() || 'document.bin';
  const fallback = cleaned.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  const encoded = encodeURIComponent(cleaned)
    .replace(/['()*]/gu, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
