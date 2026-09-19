import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { saveSkill, type SkillInput } from './admin_skills.ts';

const input: SkillInput = {
  name: 'file-boundary', display_name: '文件边界', description: '验证技能文本资产', content: '# Instructions',
};
// Invalid requests must fail before any database operation.
const sql = null as unknown as Sql;

test('rejects oversized UTF-8 content even when the client claims zero bytes', async () => {
  await expect(saveSkill(sql, 'tenant', 'user', {
    ...input, files: [{ path: 'scripts/large.py', content: '中'.repeat(90_000), size_bytes: 0 }],
  })).rejects.toMatchObject({ httpStatus: 400, code: 'SKILL_INVALID' });
});

test('rejects duplicate paths, traversal and non-text content at the persistence boundary', async () => {
  const file = { path: 'references/notes.md', content: 'notes', size_bytes: 5 };
  for (const files of [
    [file, { ...file, content: 'replacement' }],
    [{ ...file, path: 'scripts/../secret' }],
    [{ ...file, content: 'binary\u0000data' }],
    [{ ...file, content: '\ud800' }],
  ]) {
    await expect(saveSkill(sql, 'tenant', 'user', { ...input, files }))
      .rejects.toMatchObject({ httpStatus: 400, code: 'SKILL_INVALID' });
  }
});
