import { stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ApiClient } from "./api.ts";
import {
  booleanOption,
  listOption,
  numberOption,
  type ParsedArgs,
  stringOption,
} from "./args.ts";
import { CliError } from "./errors.ts";
import { printDocuments, printJson, printKnowledgeBases } from "./render.ts";
import type {
  AdminDocument,
  AdminDocumentDetail,
  KnowledgeBase,
  KnowledgeBaseUpsert,
} from "./types.ts";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const FAILED_DOCUMENT_STATUSES = new Set([
  "parse_failed",
  "embedding_failed",
  "parse_low_confidence",
  "excluded_from_search",
]);

export async function knowledgeBaseCommand(
  args: ParsedArgs,
  api: ApiClient,
  json: boolean,
): Promise<number> {
  const subcommand = args.positionals[1] ?? "list";
  if (subcommand === "list") {
    const items = booleanOption(args, "accessible")
      ? await api.listKnowledgeBases()
      : await api.listAdminKnowledgeBases();
    if (json) printJson(items); else printKnowledgeBases(items);
    return 0;
  }
  if (subcommand === "show") {
    const id = requiredPositional(args, 2, "kb show 需要知识库 ID");
    const item = await findKnowledgeBase(api, id);
    if (json) printJson(item); else printKnowledgeBases([item]);
    return 0;
  }
  if (subcommand === "create") {
    const input = createKnowledgeBaseInput(args);
    const item = await api.createKnowledgeBase(input);
    if (json) printJson(item); else printKnowledgeBases([item]);
    return 0;
  }
  if (subcommand === "update") {
    const id = requiredPositional(args, 2, "kb update 需要知识库 ID");
    const current = await findKnowledgeBase(api, id);
    const item = await api.updateKnowledgeBase(id, updateKnowledgeBaseInput(args, current));
    if (json) printJson(item); else printKnowledgeBases([item]);
    return 0;
  }
  if (subcommand === "delete") {
    const id = requiredPositional(args, 2, "kb delete 需要知识库 ID");
    requireForce(args, "删除知识库会级联删除其文档和解析数据");
    const result = await api.deleteKnowledgeBase(id);
    if (json) printJson(result); else process.stdout.write(`已删除知识库 ${id}\n`);
    return 0;
  }
  throw new CliError(`未知 kb 子命令: ${subcommand}`, 2);
}

export async function documentCommand(
  args: ParsedArgs,
  api: ApiClient,
  json: boolean,
): Promise<number> {
  const subcommand = args.positionals[1] ?? "list";
  if (subcommand === "list") return listDocuments(args, api, json);
  if (["show", "preview", "blocks", "cleaned-blocks", "chunks", "tables"].includes(subcommand)) {
    return showDocumentSection(args, api, json, subcommand);
  }
  if (subcommand === "upload") return uploadDocument(args, api, json);
  if (subcommand === "download") return downloadDocument(args, api, json);
  if (subcommand === "move") return moveDocument(args, api, json);
  if (subcommand === "delete") return deleteDocument(args, api, json);
  if (subcommand === "retry") return retryDocument(args, api, json);
  if (subcommand === "retry-batch") return retryDocuments(args, api, json);
  if (subcommand === "force-index") return forceIndexDocument(args, api, json);
  if (subcommand === "exclude") return excludeDocument(args, api, json);
  if (subcommand === "replace") return replaceDocument(args, api, json);
  if (subcommand === "ocr") return sendDocumentToOcr(args, api, json);
  if (subcommand === "wait") return waitDocument(args, api, json);
  throw new CliError(`未知 documents 子命令: ${subcommand}`, 2);
}

async function listDocuments(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const kbId = stringOption(args, "kb");
  const status = stringOption(args, "status");
  const query = stringOption(args, "query");
  const items = await api.listDocuments({
    ...(kbId ? { kbId } : {}),
    ...(status ? { status } : {}),
    ...(query ? { query } : {}),
    limit: numberOption(args, "limit", 100, { min: 1, max: 200 }),
  });
  if (json) printJson(items); else printDocuments(items);
  return 0;
}

async function showDocumentSection(
  args: ParsedArgs,
  api: ApiClient,
  json: boolean,
  section: string,
): Promise<number> {
  const id = requiredPositional(args, 2, `documents ${section} 需要文档 ID`);
  const detail = await api.getDocument(id);
  if (section === "show") {
    if (json) printJson(detail);
    else printDocumentDetail(detail);
    return 0;
  }
  const value = documentSection(detail, section);
  if (json) printJson(value);
  else if (section === "chunks") printChunks(detail);
  else if (section === "preview") printPreview(detail);
  else printJson(value);
  return 0;
}

async function uploadDocument(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const path = requiredPositional(args, 2, "documents upload 需要文件路径");
  const kbId = requiredOption(args, "kb", "documents upload 需要 --kb <知识库ID>");
  const file = await localUpload(path);
  const uploaded = await api.uploadDocument(kbId, file.blob, file.name);
  const document = booleanOption(args, "wait")
    ? await waitForDocument(api, uploaded.document_id, waitOptions(args))
    : undefined;
  const result = document ? { upload: uploaded, document } : uploaded;
  if (json) printJson(result);
  else {
    process.stdout.write(
      `已上传 ${file.name} · document=${uploaded.document_id} · job=${uploaded.parse_job_id}\n`,
    );
    if (document) printDocuments([document]);
  }
  return 0;
}

async function downloadDocument(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const id = requiredPositional(args, 2, "documents download 需要文档 ID");
  const detail = await api.getDocument(id);
  const target = resolve(stringOption(args, "output") ?? detail.document.file_name);
  const downloaded = await api.downloadDocument(id);
  try {
    await writeFile(target, downloaded.bytes, { flag: booleanOption(args, "force") ? "w" : "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") {
      throw new CliError(`目标文件已存在: ${target}；使用 --force 覆盖`, 2);
    }
    throw new CliError(`无法写入下载文件: ${target}`, 1, error);
  }
  const result = {
    document_id: id,
    path: target,
    bytes: downloaded.bytes.byteLength,
    ...(downloaded.content_type ? { content_type: downloaded.content_type } : {}),
  };
  if (json) printJson(result);
  else process.stdout.write(`已下载 ${detail.document.file_name} → ${target}\n`);
  return 0;
}

async function moveDocument(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const id = requiredPositional(args, 2, "documents move 需要文档 ID");
  const kbId = requiredOption(args, "kb", "documents move 需要 --kb <目标知识库ID>");
  const document = await api.moveDocument(id, kbId);
  if (json) printJson(document); else printDocuments([document]);
  return 0;
}

async function deleteDocument(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const id = requiredPositional(args, 2, "documents delete 需要文档 ID");
  requireForce(args, "删除文档会同时删除原件、解析数据和检索索引");
  const result = await api.deleteDocument(id);
  if (json) printJson(result); else process.stdout.write(`已删除文档 ${id}\n`);
  return 0;
}

async function retryDocument(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const id = requiredPositional(args, 2, "documents retry 需要文档 ID");
  const retried = await api.retryDocument(id);
  const document = booleanOption(args, "wait")
    ? await waitForDocument(api, id, waitOptions(args))
    : retried;
  if (json) printJson(document); else printDocuments([document]);
  return 0;
}

async function retryDocuments(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const ids = unique([
    ...args.positionals.slice(2).flatMap(splitList),
    ...listOption(args, "doc"),
  ]);
  if (ids.length === 0) throw new CliError("documents retry-batch 需要至少一个文档 ID", 2);
  if (ids.length > 50) throw new CliError("documents retry-batch 一次最多处理 50 个文档", 2);
  const result = await api.retryDocuments(ids);
  if (json) printJson({ ...result, document_ids: ids });
  else process.stdout.write(`已提交 ${result.retried} 个文档重新解析\n`);
  return 0;
}

async function forceIndexDocument(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const id = requiredPositional(args, 2, "documents force-index 需要文档 ID");
  const result = await api.forceIndexDocument(id);
  if (json) printJson(result);
  else process.stdout.write(`已确认索引 ${id} · job=${result.parse_job_id}\n`);
  return 0;
}

async function excludeDocument(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const id = requiredPositional(args, 2, "documents exclude 需要文档 ID");
  requireForce(args, "文档将保留，但会从检索索引中排除");
  const result = await api.excludeDocumentFromSearch(id);
  if (json) printJson(result);
  else process.stdout.write(`已排除检索 ${id} · 删除索引切片 ${result.es_deleted_chunks}\n`);
  return 0;
}

async function replaceDocument(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const id = requiredPositional(args, 2, "documents replace 需要文档 ID");
  const path = requiredPositional(args, 3, "documents replace 需要新文件路径");
  const file = await localUpload(path);
  const replaced = await api.replaceDocumentFile(id, file.blob, file.name);
  const document = booleanOption(args, "wait")
    ? await waitForDocument(api, id, waitOptions(args))
    : undefined;
  const result = document ? { replace: replaced, document } : replaced;
  if (json) printJson(result);
  else {
    process.stdout.write(`已替换文档 ${id} · job=${replaced.parse_job_id}\n`);
    if (document) printDocuments([document]);
  }
  return 0;
}

async function sendDocumentToOcr(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const id = requiredPositional(args, 2, "documents ocr 需要文档 ID");
  const queued = await api.sendDocumentToOcr(id);
  const document = booleanOption(args, "wait")
    ? await waitForDocument(api, id, waitOptions(args))
    : undefined;
  const result = document ? { ocr: queued, document } : queued;
  if (json) printJson(result);
  else {
    process.stdout.write(`已送入 OCR ${id} · job=${queued.ocr_job_id}\n`);
    if (document) printDocuments([document]);
  }
  return 0;
}

async function waitDocument(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const id = requiredPositional(args, 2, "documents wait 需要文档 ID");
  const document = await waitForDocument(api, id, waitOptions(args));
  if (json) printJson(document); else printDocuments([document]);
  return 0;
}

export async function waitForDocument(
  api: Pick<ApiClient, "getDocument">,
  id: string,
  options: { until: string; timeoutMs: number; intervalMs: number },
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => Bun.sleep(milliseconds),
): Promise<AdminDocument> {
  const startedAt = Date.now();
  while (true) {
    const document = (await api.getDocument(id)).document;
    if (document.parse_status === options.until) return document;
    if (FAILED_DOCUMENT_STATUSES.has(document.parse_status)) {
      throw new CliError(
        `文档 ${id} 未达到 ${options.until}，最终状态为 ${document.parse_status}`,
        1,
        document,
      );
    }
    if (Date.now() - startedAt >= options.timeoutMs) {
      throw new CliError(
        `等待文档 ${id} 达到 ${options.until} 超时，当前状态为 ${document.parse_status}`,
        1,
        document,
      );
    }
    await sleep(options.intervalMs);
  }
}

function waitOptions(args: ParsedArgs): { until: string; timeoutMs: number; intervalMs: number } {
  return {
    until: stringOption(args, "until") ?? "indexed",
    timeoutMs: numberOption(args, "timeout", 300, { min: 1, max: 3600 }) * 1000,
    intervalMs: numberOption(args, "interval", 1, { min: 0.1, max: 30 }) * 1000,
  };
}

async function findKnowledgeBase(api: ApiClient, id: string): Promise<KnowledgeBase> {
  const item = (await api.listAdminKnowledgeBases()).find((kb) => kb.id === id);
  if (!item) throw new CliError(`当前租户中未找到知识库: ${id}`, 1);
  return item;
}

function createKnowledgeBaseInput(args: ParsedArgs): KnowledgeBaseUpsert {
  const name = requiredOption(args, "name", "kb create 需要 --name <名称>");
  const description = stringOption(args, "description");
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    status: stringOption(args, "status") ?? "active",
    tags: tagOptions(args),
  };
}

function updateKnowledgeBaseInput(args: ParsedArgs, current: KnowledgeBase): KnowledgeBaseUpsert {
  const description = stringOption(args, "description");
  const hasTags = args.options.tag !== undefined || args.options.tags !== undefined;
  return {
    name: stringOption(args, "name") ?? current.name,
    description: description ?? current.description ?? "",
    status: stringOption(args, "status") ?? current.status,
    tags: hasTags ? tagOptions(args) : current.tags,
  };
}

function tagOptions(args: ParsedArgs): string[] {
  return unique([...listOption(args, "tag"), ...listOption(args, "tags")]);
}

async function localUpload(path: string): Promise<{ blob: Blob; name: string }> {
  const absolute = resolve(path);
  let metadata;
  try {
    metadata = await stat(absolute);
  } catch (error) {
    throw new CliError(`文件不存在或无法读取: ${absolute}`, 2, error);
  }
  if (!metadata.isFile()) throw new CliError(`上传路径不是文件: ${absolute}`, 2);
  if (metadata.size > MAX_UPLOAD_BYTES) {
    throw new CliError(`文件超过 100MB 上传限制: ${absolute}`, 2);
  }
  return { blob: Bun.file(absolute), name: basename(absolute) };
}

function documentSection(detail: AdminDocumentDetail, section: string): unknown {
  if (section === "preview") return detail.preview;
  if (section === "blocks") return detail.blocks;
  if (section === "cleaned-blocks") return detail.cleaned_blocks;
  if (section === "chunks") return detail.chunks;
  if (section === "tables") return detail.tables;
  throw new CliError(`未知文档详情区段: ${section}`, 2);
}

function printDocumentDetail(detail: AdminDocumentDetail): void {
  printDocuments([detail.document]);
  process.stdout.write("\n详情\n");
  printJson({
    latest_job: detail.latest_job ?? null,
    preview: detail.preview,
    blocks: detail.blocks.length,
    cleaned_blocks: detail.cleaned_blocks.length,
    chunks: detail.chunks.length,
    tables: detail.tables.length,
  });
}

function printPreview(detail: AdminDocumentDetail): void {
  const preview = detail.preview;
  process.stdout.write(`${String(preview.title ?? detail.document.title)}\n`);
  process.stdout.write(`${String(preview.text ?? "")}\n`);
}

function printChunks(detail: AdminDocumentDetail): void {
  for (const chunk of detail.chunks) {
    process.stdout.write(
      `#${chunk.chunk_index} ${chunk.chunk_id} ${chunk.source_type} tokens=${chunk.token_count}\n` +
      `${chunk.content}\n\n`,
    );
  }
  if (detail.chunks.length === 0) process.stdout.write("(无切片)\n");
}

function requiredPositional(args: ParsedArgs, index: number, message: string): string {
  const value = args.positionals[index];
  if (!value) throw new CliError(message, 2);
  return value;
}

function requiredOption(args: ParsedArgs, name: string, message: string): string {
  const value = stringOption(args, name);
  if (!value) throw new CliError(message, 2);
  return value;
}

function requireForce(args: ParsedArgs, message: string): void {
  if (!booleanOption(args, "force")) throw new CliError(`${message}；确认后请添加 --force`, 2);
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}
