import { CliError } from "./errors.ts";

/** Run against an already-open, authenticated server preview, never a local app. */
export async function checkContinuousPreview(session = "default"): Promise<number> {
  const script = `(async () => {
    const wait = async (test) => { for (let i = 0; i < 100; i++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('预览状态等待超时'); };
    const shell = document.querySelector('.dm-pdf-viewer-shell');
    if (!shell) throw new Error('请先在服务器页面打开一个 PDF/Word 原文预览');
    const viewport = shell.querySelector('.dm-pdf-viewer');
    await wait(() => shell.querySelector('canvas')?.width > 0);
    const pages = [...shell.querySelectorAll('.dm-pdf-page')];
    const toolbar = shell.querySelector('.dm-pdf-toolbar');
    if (!toolbar.textContent.includes('上下滚动')) throw new Error('不是连续滚动阅读器');
    const reset = toolbar.querySelector('[aria-label="舒适阅读"]');
    reset.click(); await new Promise(resolve => setTimeout(resolve, 250));
    const percent = () => Number(toolbar.textContent.match(/(\\d+)%/)?.[1]);
    if (!(percent() > 0 && percent() <= 100)) throw new Error('默认比例超过 100%');
    if (viewport.scrollWidth > viewport.clientWidth + 2) throw new Error('默认模式出现横向溢出');
    if (pages.length > 1) {
      const target = Math.min(4, pages.length);
      viewport.scrollTop = pages[target - 1].offsetTop;
      await wait(() => Number(toolbar.querySelector('input').value) === target);
      await wait(() => pages[target - 1].querySelector('canvas')?.width > 0);
    }
    if (pages.length > 6 && shell.querySelectorAll('canvas').length >= pages.length) throw new Error('没有按需释放远页画布');
    const current = Number(toolbar.querySelector('input').value);
    for (let i = 0; i < 3; i++) toolbar.querySelector('[aria-label="放大"]').click();
    await new Promise(resolve => setTimeout(resolve, 300));
    reset.click();
    await wait(() => percent() <= 100 && Number(toolbar.querySelector('input').value) === current);
    await wait(() => pages[current - 1].querySelector('canvas')?.width > 0);
    const error = shell.querySelector('[role="alert"]');
    if (error) throw new Error(error.textContent);
    return { ok: true, pages: pages.length, canvases: shell.querySelectorAll('canvas').length, page: current, scale: percent(), continuous: true };
  })()`;
  const process = Bun.spawn(["agent-browser", "--session", session, "eval", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exit !== 0) throw new CliError(stderr || stdout || "连续预览检查失败", 1);
  console.log(stdout.trim());
  return 0;
}
