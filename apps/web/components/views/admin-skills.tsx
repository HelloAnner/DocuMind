"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, BookOpenText, ChevronDown, FileArchive, MessageSquareText, Plus, Search, Sparkles, Trash2, Upload, X } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import styles from "./admin-skills.module.css";

interface SkillFile { path: string; content: string; size_bytes: number }
interface Skill {
  id: string;
  name: string;
  display_name: string;
  description: string;
  content?: string;
  revision: number;
  source: "editor" | "upload" | "import" | "conversation";
  source_url: string | null;
  updated_at: string;
  files?: SkillFile[];
}
type Tab = "instruction" | "scripts" | "references";
const EMPTY: Omit<Skill, "id" | "updated_at"> = {
  name: "", display_name: "", description: "", content: "", revision: 1,
  source: "editor", source_url: null, files: [],
};

export function SkillManagement({ canEdit }: { canEdit: boolean }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<Skill | typeof EMPTY | null>(null);
  const [saved, setSaved] = useState("");
  const [tab, setTab] = useState<Tab>("instruction");
  const [selectedPath, setSelectedPath] = useState("");
  const [pathDialog, setPathDialog] = useState<{ original?: string; path: string } | null>(null);
  const [pathError, setPathError] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = !!editing && JSON.stringify(editing) !== saved;
  const locked = busy || !canEdit;

  const load = async () => {
    const response = await apiFetch("/api/admin/skills");
    if (!response.ok) throw new Error(await errorMessage(response));
    setSkills((await response.json()).items ?? []);
  };
  const acceptSkill = (skill: Skill | typeof EMPTY) => {
    setEditing(skill);
    setSaved(JSON.stringify(skill));
    setTab("instruction");
    setSelectedPath("");
  };
  const openSkill = async (id: string) => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const response = await apiFetch(`/api/admin/skills/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(await errorMessage(response));
      acceptSkill(await response.json());
      const url = new URL(window.location.href);
      url.searchParams.set("skill", id);
      window.history.replaceState(window.history.state, "", url);
    } catch (cause) { setError(message(cause, "技能加载失败")); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    load().catch((cause) => setError(message(cause, "技能列表加载失败")));
    const id = new URLSearchParams(window.location.search).get("skill");
    if (id) void openSkill(id);
  }, []);

  useEffect(() => {
    const unsaved = dirty || uploadOpen || importOpen || !!pathDialog;
    if (!unsaved && !busy) return;
    const confirmLeave = () => !busy && (!unsaved || window.confirm("有未保存的技能修改或待处理文件，确定放弃吗？"));
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const beforeClose = (event: Event) => { if (!confirmLeave()) event.preventDefault(); };
    const beforeNavigate = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.("a[href]");
      if (anchor && !confirmLeave()) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("documind:before-close", beforeClose);
    document.addEventListener("click", beforeNavigate, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("documind:before-close", beforeClose);
      document.removeEventListener("click", beforeNavigate, true);
    };
  }, [dirty, busy, uploadOpen, importOpen, pathDialog]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills.filter((skill) => `${skill.display_name} ${skill.name} ${skill.description}`.toLowerCase().includes(needle));
  }, [query, skills]);
  const closeEditor = () => {
    if (busy || (dirty && !window.confirm("有未保存的技能修改，确定放弃吗？"))) return;
    setEditing(null);
    setError("");
    setSuccess("");
    const url = new URL(window.location.href);
    url.searchParams.delete("skill");
    window.history.replaceState(window.history.state, "", url);
  };
  const save = async () => {
    if (!editing || locked) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      validateFiles(editing.files ?? [], editing.content ?? "");
      const isNew = !("id" in editing);
      const response = await apiFetch(isNew ? "/api/admin/skills" : `/api/admin/skills/${editing.id}`, {
        method: isNew ? "POST" : "PUT", body: JSON.stringify({ ...editing, source: "editor" }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const skill = await response.json() as Skill;
      setEditing(skill);
      setSaved(JSON.stringify(skill));
      const url = new URL(window.location.href);
      url.searchParams.set("skill", skill.id);
      window.history.replaceState(window.history.state, "", url);
      setSuccess(`已保存 · v${skill.revision}`);
      await load();
    } catch (cause) { setError(message(cause, "保存失败")); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!editing || locked || !("id" in editing) || !confirm(`删除技能「${editing.display_name}」及其所有文件？`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch(`/api/admin/skills/${editing.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await errorMessage(response));
      setEditing(null);
      const url = new URL(window.location.href);
      url.searchParams.delete("skill");
      window.history.replaceState(window.history.state, "", url);
      setSuccess("技能已删除");
      await load();
    } catch (cause) { setError(message(cause, "删除失败")); }
    finally { setBusy(false); }
  };
  const upload = async (file: File) => {
    if (locked) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      if (!/\.(zip|md)$/i.test(file.name) || file.size > 5 * 1024 * 1024) throw new Error("请选择不超过 5 MB 的 .zip 或 Markdown 技能包");
      const form = new FormData();
      form.set("file", file);
      const response = await apiFetch("/api/admin/skills/upload", { method: "POST", body: form });
      if (!response.ok) throw new Error(await errorMessage(response));
      acceptSkill(await response.json());
      setUploadOpen(false);
      setSuccess("技能包已上传并保存");
      await load();
    } catch (cause) { setError(message(cause, "上传失败")); }
    finally { setBusy(false); }
  };
  const importUrl = async (url: string) => {
    if (locked) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const response = await apiFetch("/api/admin/skills/import", { method: "POST", body: JSON.stringify({ url }) });
      if (!response.ok) throw new Error(await errorMessage(response));
      acceptSkill(await response.json());
      setImportOpen(false);
      setSuccess("技能已导入并保存");
      await load();
    } catch (cause) { setError(message(cause, "导入失败")); }
    finally { setBusy(false); }
  };
  const updateFiles = (files: SkillFile[]) => {
    setEditing((current) => current ? { ...current, files } : current);
    setSuccess("");
  };
  const uploadFiles = async (uploads: FileList | null) => {
    if (!editing || locked || !uploads?.length) return;
    setBusy(true);
    setError("");
    try {
      const files = [...editing.files ?? []];
      let firstPath = "";
      for (const file of Array.from(uploads)) {
        if (file.size > 256 * 1024) throw new Error(`文件不得超过 256 KB: ${file.name}`);
        let content: string;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
        catch { throw new Error(`文件须为 UTF-8 文本: ${file.name}`); }
        const path = `${tab === "scripts" ? "scripts" : "references"}/${file.name}`;
        files.push({ path, content, size_bytes: new TextEncoder().encode(content).byteLength });
        firstPath ||= path;
      }
      validateFiles(files, editing.content ?? "");
      updateFiles(files);
      setSelectedPath(firstPath);
    } catch (cause) { setError(message(cause, "文件上传失败")); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  };
  const savePath = () => {
    if (!editing || !pathDialog || locked) return;
    try {
      const path = pathDialog.path.trim();
      const files = pathDialog.original
        ? (editing.files ?? []).map((file) => file.path === pathDialog.original ? { ...file, path } : file)
        : [...editing.files ?? [], { path, content: "", size_bytes: 0 }];
      validateFiles(files, editing.content ?? "");
      updateFiles(files);
      setSelectedPath(path);
      setTab(path.startsWith("scripts/") ? "scripts" : "references");
      setPathDialog(null);
    } catch (cause) { setPathError(message(cause, "文件路径无效")); }
  };

  if (editing) {
    const files = editing.files ?? [];
    const visibleFiles = files.filter((file) => tab === "scripts" ? file.path.startsWith("scripts/") : !file.path.startsWith("scripts/"));
    const selected = visibleFiles.find((file) => file.path === selectedPath);
    const update = (field: keyof Skill, value: string) => { setEditing({ ...editing, [field]: value }); setSuccess(""); };
    const selectTab = (next: Tab) => {
      setTab(next);
      setSelectedPath(files.find((file) => next === "scripts" ? file.path.startsWith("scripts/") : !file.path.startsWith("scripts/"))?.path ?? "");
    };
    return (
      <section className={styles.editor}>
        <header className={styles.editorHeader}>
          <button className={styles.iconButton} disabled={busy} onClick={closeEditor} aria-label="返回技能列表"><ArrowLeft size={18} /></button>
          <div className={styles.editorTitle}><strong>{editing.display_name || "新建技能"}</strong><span>{!canEdit ? "只读" : !("id" in editing) ? "新建技能 · 尚未保存" : dirty ? "有未保存修改" : "已保存"}</span></div>
          <div className={styles.editorActions}>
            {"id" in editing ? <button className={styles.dangerButton} disabled={locked} onClick={remove}><Trash2 size={15} />删除</button> : null}
            <button className={styles.primaryButton} disabled={locked} onClick={save}>{busy ? "处理中…" : "保存"}</button>
            <button className={styles.iconButton} disabled={busy} onClick={closeEditor} aria-label="关闭编辑器"><X size={18} /></button>
          </div>
        </header>
        <div className={styles.tabs} role="tablist" aria-label="技能文件分类">
          {([["instruction", "SKILL.md"], ["scripts", "脚本"], ["references", "参考文档"]] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? styles.activeTab : ""} onClick={() => selectTab(key)}>{label}</button>)}
        </div>
        <div className={styles.editorBody} role="tabpanel">
          {tab === "instruction" ? <>
            <aside className={styles.fields}>
              <label>显示名称<input disabled={locked} maxLength={100} value={editing.display_name} onChange={(event) => update("display_name", event.target.value)} placeholder="例如：周报生成器" /></label>
              <label>技能名称<input disabled={locked} maxLength={64} value={editing.name} onChange={(event) => update("name", event.target.value)} placeholder="weekly-report" /><small>小写字母、数字和连字符</small></label>
              <label>技能说明<textarea disabled={locked} maxLength={500} value={editing.description} onChange={(event) => update("description", event.target.value)} placeholder="什么时候应该使用这个技能" /></label>
              <div className={styles.fileSummary}><BookOpenText size={16} /><span>{files.length} 个附属文件 · 保存后自动生效</span></div>
            </aside>
            <main className={styles.markdownPane}>
              <div className={styles.codeTitle}><span>SKILL.md</span><span>Markdown · 最大 64 KB</span></div>
              <textarea aria-label="SKILL.md 内容" readOnly={locked} value={editing.content ?? ""} onChange={(event) => update("content", event.target.value)} spellCheck={false} placeholder={"# 执行流程\n\n写下清晰、可执行的技能指令…"} />
            </main>
          </> : <>
            <aside className={styles.fields}>
              <div className={styles.fileActions}>
                <button className={styles.secondaryButton} disabled={locked} onClick={() => { setPathError(""); setPathDialog({ path: `${tab}/` }); }}><Plus size={14} />新建文件</button>
                <button className={styles.secondaryButton} disabled={locked} onClick={() => fileInput.current?.click()}><Upload size={14} />上传</button>
                <input ref={fileInput} hidden type="file" multiple onChange={(event) => void uploadFiles(event.target.files)} />
              </div>
              <p className={styles.fileHint}>{tab === "scripts" ? "脚本仅作为文本资产保存、供对话读取，不在服务器执行。" : "支持 UTF-8 文本参考资料。"}单文件最大 256 KB，共 100 个文件。</p>
              <div className={styles.fileList} aria-label={tab === "scripts" ? "脚本文件" : "参考文件"}>
                {visibleFiles.map((file) => <button key={file.path} aria-pressed={file.path === selectedPath} className={file.path === selectedPath ? styles.selectedFile : ""} onClick={() => setSelectedPath(file.path)}><span>{file.path}</span><small>{file.size_bytes} B</small></button>)}
                {!visibleFiles.length ? <p className={styles.fileHint}>暂无文件。新建或上传后点击保存。</p> : null}
              </div>
            </aside>
            <main className={styles.markdownPane}>
              {selected ? <>
                <div className={styles.codeTitle}><span>{selected.path}</span><div className={styles.fileActions}>
                  <button className={styles.secondaryButton} disabled={locked} onClick={() => { setPathError(""); setPathDialog({ original: selected.path, path: selected.path }); }}>重命名</button>
                  <button className={styles.dangerButton} disabled={locked} onClick={() => { if (confirm(`删除文件「${selected.path}」？保存后生效。`)) { updateFiles(files.filter((file) => file.path !== selected.path)); setSelectedPath(visibleFiles.find((file) => file.path !== selected.path)?.path ?? ""); } }}><Trash2 size={14} />删除文件</button>
                </div></div>
                <textarea aria-label={`${selected.path} 内容`} readOnly={locked} value={selected.content} onChange={(event) => updateFiles(files.map((file) => file.path === selected.path ? { ...file, content: event.target.value, size_bytes: new TextEncoder().encode(event.target.value).byteLength } : file))} spellCheck={false} />
              </> : <div className={styles.empty}><BookOpenText size={24} /><span>选择文件以查看或编辑内容</span></div>}
            </main>
          </>}
        </div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {success ? <p className={styles.success} role="status">{success}</p> : null}
        {pathDialog ? <div className={styles.overlay}><form className={styles.modal} role="dialog" aria-modal="true" aria-label={pathDialog.original ? "重命名文件" : "新建文件"} onSubmit={(event) => { event.preventDefault(); savePath(); }}>
          <header><h2>{pathDialog.original ? "重命名文件" : "新建文件"}</h2><button type="button" className={styles.iconButton} aria-label="关闭文件对话框" onClick={() => setPathDialog(null)}><X size={18} /></button></header>
          <label className={styles.urlField}>文件路径<input autoFocus value={pathDialog.path} onChange={(event) => setPathDialog({ ...pathDialog, path: event.target.value })} placeholder={`${tab}/example.${tab === "scripts" ? "py" : "md"}`} /></label>
          <p className={styles.fileHint}>使用相对路径；scripts/ 下的文件归入脚本，其余归入参考文档。</p>
          {pathError ? <p className={styles.error} role="alert">{pathError}</p> : null}
          <footer><button type="button" className={styles.secondaryButton} onClick={() => setPathDialog(null)}>取消</button><button className={styles.primaryButton} disabled={locked}>确定</button></footer>
        </form></div> : null}
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <header className={styles.hero}>
        <div><h1>技能管理</h1><p>创建和管理可在所有对话中自动使用的技能</p></div>
        {canEdit ? <div className={styles.createWrap}>
          <button className={styles.primaryButton} disabled={busy} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><Plus size={16} />自定义技能<ChevronDown size={15} /></button>
          {menuOpen ? <div className={styles.menu}>
            <Link href="/chat?create=skill" target="_top"><MessageSquareText size={17} /><span><strong>对话创建</strong><small>在主工作区新建对话并准备技能草稿</small></span></Link>
            <button onClick={() => { setMenuOpen(false); setError(""); setSuccess(""); acceptSkill({ ...EMPTY }); }}><Sparkles size={17} /><span><strong>手动创建</strong><small>直接编写 SKILL.md</small></span></button>
            <button onClick={() => { setMenuOpen(false); setError(""); setUploadOpen(true); }}><Upload size={17} /><span><strong>上传技能包</strong><small>上传 .zip 或 SKILL.md</small></span></button>
            <button onClick={() => { setMenuOpen(false); setError(""); setImportOpen(true); }}><FileArchive size={17} /><span><strong>从 URL 导入</strong><small>从公网 HTTPS 地址导入</small></span></button>
          </div> : null}
        </div> : null}
      </header>
      <div className={styles.search}><Search size={17} /><input aria-label="搜索技能" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能" /></div>
      {error && !uploadOpen && !importOpen ? <p className={styles.error} role="alert">{error}</p> : null}
      {success ? <p className={styles.success} role="status">{success}</p> : null}
      <div className={styles.grid}>
        {filtered.map((skill) => <button className={styles.card} disabled={busy} key={skill.id} onClick={() => void openSkill(skill.id)}>
          <div className={styles.cardTop}><span className={styles.skillIcon}><Sparkles size={20} /></span><ArrowUpRight size={18} aria-hidden="true" /></div>
          <strong>{skill.display_name}</strong><code>{skill.name}</code><p>{skill.description}</p>
          <footer><span>v{skill.revision}</span><time>{relativeTime(skill.updated_at)}</time></footer>
        </button>)}
      </div>
      {!busy && filtered.length === 0 ? <div className={styles.empty}><Sparkles size={26} /><strong>{query ? "没有匹配的技能" : "暂无技能"}</strong><span>手动创建、上传技能包，或在对话中保存一个技能。</span></div> : null}
      {uploadOpen ? <UploadDialog busy={busy} error={error} onClose={() => { setUploadOpen(false); setError(""); }} onUpload={upload} /> : null}
      {importOpen ? <ImportDialog busy={busy} error={error} onClose={() => { setImportOpen(false); setError(""); }} onImport={importUrl} /> : null}
    </section>
  );
}

function UploadDialog({ busy, error, onClose, onUpload }: { busy: boolean; error: string; onClose: () => void; onUpload: (file: File) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => { if (!busy && (!file || confirm("放弃已选择的技能包？"))) onClose(); };
  return <div className={styles.overlay}><section className={styles.modal} role="dialog" aria-modal="true" aria-label="上传技能包">
    <header><div><h2>上传技能包</h2><p>上传包含 SKILL.md 的技能包</p></div><button className={styles.iconButton} disabled={busy} aria-label="关闭上传对话框" onClick={close}><X size={18} /></button></header>
    <button className={styles.dropZone} disabled={busy} onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!busy) setFile(event.dataTransfer.files[0] ?? null); }}>
      <span className={styles.uploadIcon}><Upload size={24} /></span><strong>{file ? file.name : "拖拽技能包到此处"}</strong><span>或点击选择文件</span><small>支持 .zip 和 SKILL.md 文件，最大 5 MB</small>
    </button>
    <input hidden ref={inputRef} disabled={busy} type="file" accept=".zip,.md,text/markdown,application/zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <footer><button className={styles.secondaryButton} disabled={busy} onClick={close}>取消</button><button className={styles.primaryButton} disabled={!file || busy} onClick={() => file && onUpload(file)}>{busy ? "上传中…" : "上传并创建"}</button></footer>
  </section></div>;
}

function ImportDialog({ busy, error, onClose, onImport }: { busy: boolean; error: string; onClose: () => void; onImport: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const close = () => { if (!busy && (!url || confirm("放弃已填写的导入地址？"))) onClose(); };
  return <div className={styles.overlay}><form className={styles.modal} role="dialog" aria-modal="true" aria-label="从 URL 导入技能" onSubmit={(event) => { event.preventDefault(); if (!busy) onImport(url.trim()); }}>
    <header><div><h2>从 URL 导入</h2><p>仅支持解析到公网地址的 HTTPS 链接</p></div><button type="button" className={styles.iconButton} disabled={busy} aria-label="关闭导入对话框" onClick={close}><X size={18} /></button></header>
    <label className={styles.urlField}>技能包地址<input autoFocus required type="url" disabled={busy} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/skill.zip" /></label>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <footer><button type="button" className={styles.secondaryButton} disabled={busy} onClick={close}>取消</button><button className={styles.primaryButton} disabled={!url.trim() || busy}>{busy ? "导入中…" : "导入"}</button></footer>
  </form></div>;
}

function validateFiles(files: SkillFile[], content: string): void {
  let total = new TextEncoder().encode(content).byteLength;
  if (total > 64 * 1024) throw new Error("SKILL.md 不得超过 64 KB");
  if (files.length > 100) throw new Error("附属文件不得超过 100 个");
  const paths = new Set<string>();
  for (const file of files) {
    if (!file.path || file.path.length > 240 || /[\\:\u0000-\u001f\u007f]/.test(file.path) || file.path.split("/").some((part) => !part || part === "." || part === ".." || part.trim() !== part) || file.path.split("/").pop()?.toLowerCase() === "skill.md") throw new Error(`文件须使用安全的相对路径，且不能命名为 SKILL.md: ${file.path}`);
    if (paths.has(file.path)) throw new Error(`文件已存在: ${file.path}`);
    paths.add(file.path);
    const bytes = new TextEncoder().encode(file.content);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(file.content) || new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== file.content) throw new Error(`文件须为 UTF-8 文本: ${file.path}`);
    if (bytes.byteLength > 256 * 1024) throw new Error(`文件不得超过 256 KB: ${file.path}`);
    total += bytes.byteLength;
  }
  if (total > 5 * 1024 * 1024) throw new Error("技能文本总大小不得超过 5 MB");
}
function message(cause: unknown, fallback: string): string { return cause instanceof Error ? cause.message : fallback; }
function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = init?.body instanceof FormData ? getAuthHeaders() : { "Content-Type": "application/json", ...getAuthHeaders() };
  return fetch(`${process.env.NEXT_PUBLIC_API_BASE ?? ""}${input}`, { ...init, headers });
}
async function errorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}));
  return body.message || body.detail || `请求失败 (${response.status})`;
}
function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  return `${Math.floor(hours / 24)} 天前更新`;
}
