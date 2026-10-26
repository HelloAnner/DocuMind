import { createHash } from "node:crypto";

export async function checkBrand(base: string, code: string, fetcher: typeof fetch = fetch) {
  const pageUrl = new URL(base.replace(/\/+$/, "") + "/");
  const page = await fetcher(pageUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!page.ok || !page.headers.get("content-type")?.includes("text/html")) throw new Error("Brand page must return HTML");
  const html = await page.text();
  const href = html.match(/<link\b[^>]*\brel=["']icon["'][^>]*\bhref=["']([^"']+)["']/i)?.[1];
  if (!href) throw new Error("Missing SVG favicon metadata");
  const iconUrl = new URL(href, pageUrl);
  const validPath = iconUrl.pathname === pageUrl.pathname + "favicon.svg" || (pageUrl.pathname === "/" && iconUrl.pathname === `/${code}/favicon.svg`);
  if (iconUrl.origin !== pageUrl.origin || !validPath) throw new Error("Favicon must use the application base path");
  const response = await fetcher(iconUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  const svg = await response.text();
  if (!response.ok || !response.headers.get("content-type")?.includes("image/svg+xml") ||
      !svg.includes(`data-brand="${code}"`) || !svg.includes('viewBox="0 0 64 64"') || /<script|<image|<foreignObject|\bon\w+\s*=/i.test(svg)) {
    throw new Error(`Invalid ${code} SVG favicon`);
  }
  return { ok: true, system: code, icon: iconUrl.href, sha256: createHash("sha256").update(svg).digest("hex") };
}
