"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpenText, ChevronDown, FileArchive, MessageSquareText, MoreHorizontal, Plus, Search, Sparkles, Trash2, Upload, X } from "lucide-react";
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

const EMPTY: Omit<Skill, "id" | "updated_at"> = {
  name: "", display_name: "", description: "", content: "", revision: 1,
  source: "editor", source_url: null, files: [],
};

export function SkillManagement({ canEdit }: { canEdit: boolean }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<Skill | typeof EMPTY | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    const response = await apiFetch("/api/admin/skills");
    if (!response.ok) throw new Error("技能列表加载失败");
    setSkills((await response.json()).items ?? []);
  };

  useEffect(() => { load().catch((cause) => setError(cause instanceof Error ? cause.message : "技能列表加载失败")); }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => `${skill.display_name} ${skill.name} ${skill.description}`.toLowerCase().includes(needle));
  }, [query, skills]);

  const openSkill = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch(`/api/admin/skills/${id}`);
      if (!response.ok) throw new Error("技能加载失败");
      setEditing(await response.json());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "技能加载失败");
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      const isNew = !("id" in editing);
      const response = await apiFetch(isNew ? "/api/admin/skills" : `/api/admin/skills/${editing.id}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...editing, source: "editor" }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setEditing(await response.json());
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!editing || !("id" in editing) || !confirm(`删除技能「${editing.display_name}」？`)) return;
    setBusy(true);
    try {
      const response = await apiFetch(`/api/admin/skills/${editing.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await errorMessage(response));
      setEditing(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    } finally { setBusy(false); }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError("");
    const form = new FormData();
    form.set("file", file);
    try {
      const response = await apiFetch("/api/admin/skills/upload", { method: "POST", body: form });
      if (!response.ok) throw new Error(await errorMessage(response));
      setUploadOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "上传失败");
    } finally { setBusy(false); }
  };

  const importUrl = async (url: string) => {
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/admin/skills/import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setImportOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入失败");
    } finally { setBusy(false); }
  };

  if (editing) {
    const update = (field: keyof Skill, value: string) => setEditing((current) => current ? { ...current, [field]: value } : current);
    return (
      <section className={styles.editor}>
        <header className={styles.editorHeader}>
          <button className={styles.iconButton} onClick={() => setEditing(null)} aria-label="返回技能列表"><ArrowLeft size={18} /></button>
          <div className={styles.editorTitle}><strong>{editing.display_name || "新建技能"}</strong><span>编辑技能</span></div>
          <div className={styles.editorActions}>
            {"id" in editing ? <button className={styles.dangerButton} disabled={busy || !canEdit} onClick={remove}><Trash2 size={15} />删除</button> : null}
            <button className={styles.primaryButton} disabled={busy || !canEdit} onClick={save}>{busy ? "保存中…" : "保存"}</button>
            <button className={styles.iconButton} onClick={() => setEditing(null)} aria-label="关闭"><X size={18} /></button>
          </div>
        </header>
        <div className={styles.tabs}><button className={styles.activeTab}>SKILL.md</button><button title="当前版本不执行脚本">脚本</button><button>参考文档</button></div>
        <div className={styles.editorBody}>
          <aside className={styles.fields}>
            <label>显示名称<input value={editing.display_name} onChange={(event) => update("display_name", event.target.value)} placeholder="例如：周报生成器" /></label>
            <label>技能名称<input value={editing.name} onChange={(event) => update("name", event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="weekly-report" /><small>小写字母、数字和连字符</small></label>
            <label>技能说明<textarea value={editing.description} onChange={(event) => update("description", event.target.value)} placeholder="什么时候应该使用这个技能" /></label>
            <div className={styles.fileSummary}><BookOpenText size={16} /><span>{editing.files?.length ?? 0} 个参考文件</span></div>
          </aside>
          <main className={styles.markdownPane}>
            <div className={styles.codeTitle}><span>SKILL.md</span><span>Markdown</span></div>
            <textarea value={editing.content ?? ""} onChange={(event) => update("content", event.target.value)} spellCheck={false} placeholder="# 执行流程\n\n写下清晰、可执行的技能指令…" />
          </main>
        </div>
        {error ? <p className={styles.error}>{error}</p> : null}
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <header className={styles.hero}>
        <div><h1>技能管理</h1><p>创建和管理可在所有对话中自动使用的技能</p></div>
        {canEdit ? <div className={styles.createWrap}>
          <button className={styles.primaryButton} onClick={() => setMenuOpen((value) => !value)}><Plus size={16} />自定义技能<ChevronDown size={15} /></button>
          {menuOpen ? <div className={styles.menu}>
            <button onClick={() => { setMenuOpen(false); window.location.href = "/"; }}><MessageSquareText size={17} /><span><strong>对话创建</strong><small>通过对话描述并保存技能</small></span></button>
            <button onClick={() => { setMenuOpen(false); setEditing({ ...EMPTY }); }}><Sparkles size={17} /><span><strong>手动创建</strong><small>直接编写 SKILL.md</small></span></button>
            <button onClick={() => { setMenuOpen(false); setUploadOpen(true); }}><Upload size={17} /><span><strong>上传技能包</strong><small>上传 .zip 或 SKILL.md</small></span></button>
            <button onClick={() => { setMenuOpen(false); setImportOpen(true); }}><FileArchive size={17} /><span><strong>从 URL 导入</strong><small>从公网 HTTPS 地址导入</small></span></button>
          </div> : null}
        </div> : null}
      </header>
      <div className={styles.search}><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能" /></div>
      {error ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.grid}>
        {filtered.map((skill) => <button className={styles.card} key={skill.id} onClick={() => openSkill(skill.id)}>
          <div className={styles.cardTop}><span className={styles.skillIcon}><Sparkles size={20} /></span><MoreHorizontal size={18} /></div>
          <strong>{skill.display_name}</strong><code>{skill.name}</code><p>{skill.description}</p>
          <footer><span>v{skill.revision}</span><time>{relativeTime(skill.updated_at)}</time></footer>
        </button>)}
      </div>
      {!busy && filtered.length === 0 ? <div className={styles.empty}><Sparkles size={26} /><strong>暂无技能</strong><span>手动创建、上传技能包，或在对话中保存一个技能。</span></div> : null}
      {uploadOpen ? <UploadDialog busy={busy} onClose={() => setUploadOpen(false)} onUpload={upload} inputRef={fileInput} /> : null}
      {importOpen ? <ImportDialog busy={busy} onClose={() => setImportOpen(false)} onImport={importUrl} /> : null}
    </section>
  );
}

function UploadDialog({ busy, onClose, onUpload, inputRef }: { busy: boolean; onClose: () => void; onUpload: (file: File) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [file, setFile] = useState<File | null>(null);
  return <div className={styles.overlay} role="presentation"><section className={styles.modal} role="dialog" aria-modal="true" aria-label="上传技能包">
    <header><div><h2>上传技能包</h2><p>上传包含 SKILL.md 的技能包</p></div><button className={styles.iconButton} onClick={onClose}><X size={18} /></button></header>
    <button className={styles.dropZone} onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setFile(event.dataTransfer.files[0] ?? null); }}>
      <span className={styles.uploadIcon}><Upload size={24} /></span><strong>{file ? file.name : "拖拽技能包到此处"}</strong><span>或点击选择文件</span><small>支持 .zip 和 SKILL.md 文件，最大 5 MB</small>
    </button>
    <input hidden ref={inputRef} type="file" accept=".zip,.md,text/markdown,application/zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
    <footer><button className={styles.secondaryButton} onClick={onClose}>取消</button><button className={styles.primaryButton} disabled={!file || busy} onClick={() => file && onUpload(file)}>{busy ? "上传中…" : "上传并创建"}</button></footer>
  </section></div>;
}

function ImportDialog({ busy, onClose, onImport }: { busy: boolean; onClose: () => void; onImport: (url: string) => void }) {
  const [url, setUrl] = useState("");
  return <div className={styles.overlay}><section className={styles.modal} role="dialog" aria-modal="true" aria-label="从 URL 导入技能">
    <header><div><h2>从 URL 导入</h2><p>仅支持解析到公网地址的 HTTPS 链接</p></div><button className={styles.iconButton} onClick={onClose}><X size={18} /></button></header>
    <label className={styles.urlField}>技能包地址<input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/skill.zip" /></label>
    <footer><button className={styles.secondaryButton} onClick={onClose}>取消</button><button className={styles.primaryButton} disabled={!url.trim() || busy} onClick={() => onImport(url.trim())}>{busy ? "导入中…" : "导入"}</button></footer>
  </section></div>;
}

function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = init?.body instanceof FormData
    ? { ...getAuthHeaders(), ...(init.headers ?? {}) }
    : { "Content-Type": "application/json", ...getAuthHeaders(), ...(init?.headers ?? {}) };
  return fetch(input, { ...init, headers });
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
