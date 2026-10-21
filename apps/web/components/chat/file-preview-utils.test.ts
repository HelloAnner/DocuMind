import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TEXT_PREVIEW_BYTES,
  filePreviewKind,
  findFileMention,
  isTextPreviewWithinLimit,
  matchesFileQuery,
  nextMentionIndex,
  removeFileMention,
} from "./file-preview-utils";

test("filePreviewKind 只把栅格图片识别为 image", () => {
  assert.equal(filePreviewKind({ name: "chart.PNG", mime_type: "image/png" }), "image");
  assert.equal(filePreviewKind({ name: "photo.jpeg", mime_type: "" }), "image");
  assert.equal(filePreviewKind({ name: "vector.svg", mime_type: "image/svg+xml" }), "download");
});

test("filePreviewKind 识别 PDF 和文本", () => {
  assert.equal(filePreviewKind({ name: "合同.pdf", mime_type: "" }), "pdf");
  assert.equal(filePreviewKind({ name: "unknown", mime_type: "application/pdf" }), "pdf");
  assert.equal(filePreviewKind({ name: "notes.md", mime_type: "" }), "text");
  assert.equal(filePreviewKind({ name: "data", mime_type: "text/csv; charset=utf-8" }), "text");
  assert.equal(filePreviewKind({ name: "dump.bin", mime_type: "application/octet-stream" }), "download");
});

test("文本预览上限为 200KB，边界值可预览", () => {
  assert.equal(MAX_TEXT_PREVIEW_BYTES, 204800);
  assert.equal(isTextPreviewWithinLimit(MAX_TEXT_PREVIEW_BYTES), true);
  assert.equal(isTextPreviewWithinLimit(MAX_TEXT_PREVIEW_BYTES + 1), false);
  assert.equal(isTextPreviewWithinLimit(Number.NaN), false);
});

test("findFileMention 只匹配输入末尾且位于空白之后的 @", () => {
  assert.deepEqual(findFileMention("@"), { query: "", start: 0, end: 1 });
  assert.deepEqual(findFileMention("帮我总结 @合同"), {
    query: "合同",
    start: 5,
    end: 8,
  });
  assert.deepEqual(findFileMention("第一行\n@Q3"), {
    query: "Q3",
    start: 4,
    end: 7,
  });
  assert.equal(findFileMention("a@b.com"), null);
  assert.equal(findFileMention("@合同 后续文字"), null);
  assert.equal(findFileMention("没有触发词"), null);
});

test("removeFileMention 移除末尾触发词并保留正文", () => {
  assert.equal(removeFileMention("帮我总结 @合同"), "帮我总结");
  assert.equal(removeFileMention("@合同"), "");
  assert.equal(removeFileMention("第一行\n@Q3"), "第一行");
  assert.equal(removeFileMention("没有触发词"), "没有触发词");
});

test("matchesFileQuery 忽略大小写和首尾空白", () => {
  assert.equal(matchesFileQuery("Q3 采购合同.pdf", " q3 "), true);
  assert.equal(matchesFileQuery("Q3 采购合同.pdf", "Q2"), false);
  assert.equal(matchesFileQuery("Q3 采购合同.pdf", ""), true);
});

test("nextMentionIndex 边界不循环", () => {
  assert.equal(nextMentionIndex(0, 3, 1), 1);
  assert.equal(nextMentionIndex(2, 3, 1), 2);
  assert.equal(nextMentionIndex(0, 3, -1), 0);
  assert.equal(nextMentionIndex(5, 0, 1), 0);
});
