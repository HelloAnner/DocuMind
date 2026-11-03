import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { copyToClipboard } from "../../apps/web/lib/clipboard";

test("invitation copy reports HTTP fallback success and clipboard denial without false success", async () => {
  const saved = Object.fromEntries(["document", "navigator", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const allowed of [true, false]) {
      let removed = false, selected = false;
      const area = { value: "", style: {}, setAttribute() {}, focus() {}, select() { selected = true; } };
      Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: true } });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw Error("denied"); } } } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => area, body: { appendChild() {}, removeChild() { removed = true; } }, execCommand: () => allowed } });
      expect(await copyToClipboard("http://test/documind/invite#token=test-only")).toBe(allowed);
      expect(selected && removed).toBe(true);
    }
    const view = readFileSync(new URL("../../apps/web/components/views/admin-members.tsx", import.meta.url), "utf8");
    expect(view).toContain("const copied = await copyToClipboard(url)");
    expect(view).toContain('aria-label="邀请链接"');
    expect(view).toContain('invitation.status === "accepted"');
    expect(readFileSync(new URL("../../apps/web/components/views/tenant-members.tsx", import.meta.url), "utf8")).toContain("AdminMembers as TenantMembers");
  } finally { for (const [key, value] of Object.entries(saved)) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } }
});
