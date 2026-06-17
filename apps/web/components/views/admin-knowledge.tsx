"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KnowledgeCard } from "@/components/ui/knowledge-card";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  listAdminKnowledgeBases,
  updateKnowledgeBase,
  type KnowledgeBase,
  type KnowledgeBaseUpsert,
} from "@/lib/api";

const emptyForm: KnowledgeBaseUpsert = {
  name: "",
  description: "",
  status: "active",
  tags: [],
};

export function AdminKnowledge() {
  const router = useRouter();
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<KnowledgeBase>();
  const [form, setForm] = useState<KnowledgeBaseUpsert>(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = () =>
    listAdminKnowledgeBases()
      .then(setKnowledgeBases)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return knowledgeBases;
    return knowledgeBases.filter((kb) =>
      [kb.name, kb.description ?? "", kb.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(keyword)
    );
  }, [knowledgeBases, query]);

  const openKnowledgeBase = (kbId: string) => {
    router.push(`/admin/documents?kb_id=${encodeURIComponent(kbId)}`);
  };

  const openCreate = () => {
    setEditing(undefined);
    setForm(emptyForm);
    setFormOpen(true);
  };

  const openEdit = (kb: KnowledgeBase) => {
    setEditing(kb);
    setForm({
      name: kb.name,
      description: kb.description ?? "",
      status: kb.status,
      tags: kb.tags,
    });
    setFormOpen(true);
  };

  const closeForm = () => {
    setEditing(undefined);
    setForm(emptyForm);
    setFormOpen(false);
  };

  const saveKnowledgeBase = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const payload = {
        ...form,
        tags: Array.isArray(form.tags)
          ? form.tags
          : String(form.tags ?? "")
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
      };
      if (editing) {
        await updateKnowledgeBase(editing.id, payload);
      } else {
        await createKnowledgeBase(payload);
      }
      closeForm();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const removeKnowledgeBase = async (kb: KnowledgeBase) => {
    const confirmed = window.confirm(`删除知识库“${kb.name}”？该操作会级联删除该知识库下的文档和解析数据。`);
    if (!confirmed) return;
    setError(undefined);
    try {
      await deleteKnowledgeBase(kb.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <Topbar title="知识库管理">
        <Button icon={<Plus size={14} />} onClick={openCreate}>新建知识库</Button>
      </Topbar>

      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput placeholder="搜索知识库..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {filtered.length} 个知识库</span>
        </div>

        {error ? <div className="dm-inline-error" style={{ marginBottom: 12 }}>{error}</div> : null}

        <div className="dm-knowledge-grid">
          {filtered.map((kb) => (
            <KnowledgeCard
              key={kb.id}
              name={kb.name}
              desc={kb.description ?? "暂无描述"}
              docs={kb.doc_count}
              chunks={kb.chunk_count}
              status={kb.status}
              onClick={() => openKnowledgeBase(kb.id)}
              action={
                <>
                  <Button
                    variant="secondary"
                    icon={<Pencil size={13} />}
                    onClick={(event) => {
                      event.stopPropagation();
                      openEdit(kb);
                    }}
                  >
                    管理
                  </Button>
                  <Button
                    variant="ghost"
                    icon={<Trash2 size={13} />}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeKnowledgeBase(kb).catch(console.error);
                    }}
                  >
                    删除
                  </Button>
                </>
              }
            />
          ))}
        </div>
        {filtered.length === 0 ? <div className="dm-empty-state">暂无知识库</div> : null}
      </div>

      {formOpen ? (
        <div className="dm-modal-overlay" onClick={closeForm}>
          <div className="dm-modal" onClick={(event) => event.stopPropagation()}>
            <div className="dm-modal-head">
              <h2>{editing ? "管理知识库" : "新建知识库"}</h2>
              <button className="dm-icon-button" type="button" onClick={closeForm} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <label className="dm-form-field">
              <span>名称</span>
              <input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
            </label>
            <label className="dm-form-field">
              <span>描述</span>
              <textarea
                value={form.description}
                onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
              />
            </label>
            <label className="dm-form-field">
              <span>状态</span>
              <select value={form.status} onChange={(event) => setForm((prev) => ({ ...prev, status: event.target.value }))}>
                <option value="active">启用</option>
                <option value="disabled">停用</option>
                <option value="archived">归档</option>
              </select>
            </label>
            <label className="dm-form-field">
              <span>标签</span>
              <input
                value={(form.tags ?? []).join(", ")}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean),
                  }))
                }
              />
            </label>
            <div className="dm-modal-actions">
              <Button variant="secondary" onClick={closeForm}>取消</Button>
              <Button onClick={() => saveKnowledgeBase().catch(console.error)} disabled={saving}>
                {saving ? "保存中" : "保存"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
