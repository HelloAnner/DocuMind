import { expect, test } from "bun:test";
import { checkTheme } from "../src/theme";

const html = '<html lang="zh-CN" data-theme="light"><head><script>(function(){var s=localStorage.getItem("documind-theme");var p=s==="dark"||s==="light"?s:"system";var d=window.matchMedia("(prefers-color-scheme: dark)");})();</script><link rel="stylesheet" href="/_next/static/css/a.css"></head><body><script src="/_next/static/js/a.js"></script></body></html>';
const css = ':root{--bg-primary:#faf9f7}[data-theme="dark"]{color-scheme:dark;--bg-primary:#0a0a0f}.theme-options{display:flex}.theme-toggle{width:26px}';
const js = 'const T=[["system","跟随系统"],["light","亮色"],["dark","暗色"]];';

const fetcher = (page = html, sheet = css, script = js) => (async (url: string | URL | Request) => {
  const href = String(url);
  if (href.endsWith(".css")) return new Response(sheet, { headers: { "content-type": "text/css" } });
  if (href.endsWith(".js")) return new Response(script, { headers: { "content-type": "text/javascript" } });
  return new Response(page, { headers: { "content-type": "text/html" } });
}) as typeof fetch;

test("theme check 覆盖亮暗 token、首屏脚本、默认跟随系统与统一控件", async () => {
  const result = await checkTheme("https://example.test", "documind-theme", fetcher());
  expect(result.ok).toBe(true);
  expect(result.control).toBe("跟随系统|亮色|暗色");
  expect(result.stylesheets).toBe(1);
  for (const bad of [
    fetcher(html.replace(' data-theme="light"', "")),
    fetcher(html.replace("documind-theme", "other-theme")),
    fetcher(html.replace('"system"', '"light"')),
    fetcher(html, ":root{--bg-primary:#faf9f7}"),
    fetcher(html, ':root{--bg-primary:#faf9f7}[data-theme="dark"]{--bg-primary:#0a0a0f}'),
    fetcher(html, css, 'const T=[];'),
    fetcher(html, css.replace(".theme-toggle{width:26px}", ""), js),
  ]) {
    await expect(checkTheme("https://example.test", "documind-theme", bad)).rejects.toThrow();
  }
});

test("次要路由 404 时按首页判定", async () => {
  const f = (async (url: string | URL | Request) =>
    String(url).endsWith("/chat") ? new Response("nope", { status: 404 }) : fetcher()(url)) as typeof fetch;
  const result = await checkTheme("https://example.test", "documind-theme", f);
  expect(result.ok).toBe(true);
  expect(result.stylesheets).toBe(1);
});
