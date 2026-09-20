// 移植自 crates/web_embed/src/lib.rs —— 静态 Web 资产服务（编译内嵌 + 开发期磁盘回退）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WebAsset { bytes: Uint8Array; contentType: string; }

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

// bun build --compile 时由 scripts/gen-web-assets.ts 生成真实内嵌表；
// 未生成（开发期）时该 import 不存在，走磁盘回退。
let embedded: Record<string, () => Uint8Array> | null = null;
try {
  // @ts-ignore 生成文件由 scripts/gen-web-assets.ts 在构建期产出
  const generated = await import('./generated/web_assets.ts');
  embedded = generated.default;
} catch {
  embedded = null;
}

function mimeType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return MIME_TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

function candidateDirs(): string[] {
  const dirs: string[] = [];
  const envDir = process.env.DOCUMIND_WEB_DIR ?? process.env.WEB_OUT_DIR;
  if (envDir) dirs.push(envDir);
  // apps/api-bun/src -> 仓库根 -> apps/web/out
  dirs.push(join(import.meta.dir, '..', '..', '..', 'apps', 'web', 'out'));
  return dirs;
}

function normalizePath(path: string): string {
  const decoded = decodeURIComponent(path);
  const trimmed = decoded.replace(/^\/+/, '');
  const clean = trimmed.startsWith('documind/') ? trimmed.slice('documind/'.length) : trimmed;
  if (clean.length === 0 || clean.includes('..')) return 'index.html';
  return clean;
}

function isExtensionlessRoute(path: string): boolean {
  if (path.length === 0) return false;
  const last = path.split('/').pop() ?? path;
  return !last.includes('.');
}

export function routeCandidates(path: string): string[] {
  const normalized = normalizePath(path);
  const candidates = [normalized];
  if (isExtensionlessRoute(normalized)) {
    candidates.push(`${normalized}.html`, `${normalized}/index.html`);
  }
  const segments = normalized.split('/');
  if (segments[0] === 's' && segments[1]) {
    if (segments.length === 2) candidates.push('s/__placeholder__.html');
    if (segments.length === 3 && segments[2] === 'info') {
      candidates.push('s/__placeholder__/info.html');
    }
  }
  return candidates;
}

export function getAsset(requestPath: string): WebAsset | null {
  const candidates = routeCandidates(requestPath);
  if (embedded) {
    for (const candidate of candidates) {
      const load = embedded[candidate];
      if (load) return { bytes: load(), contentType: mimeType(candidate) };
    }
  }
  for (const dir of candidateDirs()) {
    for (const candidate of candidates) {
      const path = join(dir, candidate);
      if (existsSync(path)) {
        return { bytes: readFileSync(path), contentType: mimeType(candidate) };
      }
    }
  }
  return null;
}

export function fallbackHtml(): WebAsset {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DocuMind</title>
    <style>
      body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#1a1a1a; background:#faf9f7; }
      main { width:min(560px, calc(100vw - 48px)); border:1px solid rgba(0,0,0,.08); background:#fff; border-radius:12px; padding:28px; }
      h1 { margin:0 0 12px; font-size:20px; }
      p { margin:0 0 10px; line-height:1.6; color:#5a5a5a; }
      code { background:#f5f4f2; padding:2px 5px; border-radius:4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>DocuMind runtime is running</h1>
      <p>Web assets have not been exported yet. Build the UI into <code>apps/web/out</code> or set <code>DOCUMIND_WEB_DIR</code>.</p>
    </main>
  </body>
</html>`;
  return {
    bytes: new TextEncoder().encode(html),
    contentType: 'text/html; charset=utf-8',
  };
}
