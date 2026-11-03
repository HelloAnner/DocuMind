/** 主题自检：部署产物必须带上亮/暗 token、首屏定主题脚本和四套系统统一的外观控件。 */
const THEME_LABELS = ["跟随系统", "亮色", "暗色"];

export async function checkTheme(
  base: string,
  storageKey = "documind-theme",
  fetcher: typeof fetch = fetch,
  routes: string[] = ["/", "/chat"],
) {
  const origin = base.replace(/\/+$/, "");
  let firstPage = "";
  const assets: string[] = [];
  const stylesheets: string[] = [];
  const scripts: string[] = [];

  for (const route of routes) {
    const pageUrl = new URL(origin + route);
    const page = await fetcher(pageUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!page.ok || !page.headers.get("content-type")?.includes("text/html")) {
      if (route === routes[0]) throw new Error(`主题页面必须返回 HTML：${pageUrl.href}`);
      continue;
    }
    const html = await page.text();
    if (!firstPage) firstPage = html;

    const hrefs = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/gi)].flatMap((m) => (m[1] ? [m[1]] : []));
    if (!hrefs.length && route === routes[0]) throw new Error("缺少样式表");
    stylesheets.push(...hrefs);
    scripts.push(...[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].flatMap((m) => (m[1] ? [m[1]] : [])));

    for (const href of [...new Set([...hrefs, ...scripts])]) {
      const res = await fetcher(new URL(href, pageUrl), { redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (res.ok) assets.push(await res.text());
    }
  }

  if (!/<html\b[^>]*\bdata-theme=["'](light|dark)["']/i.test(firstPage)) throw new Error("<html> 缺少 data-theme");
  if (!firstPage.includes(storageKey)) throw new Error("缺少首屏定主题脚本（会闪光）");
  // 默认跟随系统：首屏脚本读系统偏好，只有手动选择才写存储。
  if (!firstPage.includes("prefers-color-scheme") || !firstPage.includes('"system"')) {
    throw new Error("首屏脚本必须默认跟随系统主题");
  }

  const bundle = assets.join("\n");
  if (!bundle.includes("[data-theme=dark]") && !bundle.includes('[data-theme="dark"]')) throw new Error("CSS 缺少暗色 token");
  if (!/color-scheme:\s*dark/.test(bundle)) throw new Error("暗色必须设置 color-scheme:dark");
  if (!bundle.includes("--bg-primary") && !bundle.includes("--color-canvas")) throw new Error("CSS 缺少设计 token");
  for (const label of THEME_LABELS) {
    if (!bundle.includes(label)) throw new Error(`外观控件缺少选项文案：${label}`);
  }
  if (!bundle.includes("theme-toggle") || !bundle.includes("点击切换到")) {
    throw new Error("缺少统一外观控件（.theme-toggle 小图标）");
  }

  return {
    ok: true,
    page: new URL(origin + routes[0]).href,
    routes: routes.length,
    stylesheets: new Set(stylesheets).size,
    scripts: new Set(scripts).size,
    dark: true,
    light: true,
    control: THEME_LABELS.join("|"),
  };
}
