import wordScript from './scripts/cnpc-word.py' with { type: 'text' };
import excelScript from './scripts/cnpc-excel.py' with { type: 'text' };
import pptScript from './scripts/cnpc-ppt.py' with { type: 'text' };
import type { SkillRecord, SkillSummary } from '../api/admin_skills.ts';

const BUILTIN_AT = '2026-01-01T00:00:00.000Z';

const definitions = [
  {
    id: '00000000-0000-0000-0000-00000000c101',
    name: 'cnpc-word',
    display_name: '中国石油 Word 文档生成',
    description: '根据用户要求生成结构化 DOCX 文档，并将结果保存为当前用户文件。',
    scriptPath: 'scripts/cnpc-word.py',
    imagePath: '/opt/cnpc-skills/cnpc-word.py',
    script: wordScript,
    input: '{"title":"标题","sections":[{"heading":"章节","level":1,"paragraphs":["正文"],"table":[["列1","列2"],["值1","值2"]]}]}',
    output: 'result.docx',
  },
  {
    id: '00000000-0000-0000-0000-00000000c102',
    name: 'cnpc-excel',
    display_name: '中国石油 Excel 表格生成',
    description: '根据用户给出的数据生成 XLSX 工作簿，并将结果保存为当前用户文件。',
    scriptPath: 'scripts/cnpc-excel.py',
    imagePath: '/opt/cnpc-skills/cnpc-excel.py',
    script: excelScript,
    input: '{"sheets":[{"name":"数据","rows":[["项目","数值"],["示例",1]]}]}',
    output: 'result.xlsx',
  },
  {
    id: '00000000-0000-0000-0000-00000000c103',
    name: 'cnpc-ppt',
    display_name: '中国石油 PowerPoint 生成',
    description: '根据用户要求生成 PPTX 演示文稿，并将结果保存为当前用户文件。',
    scriptPath: 'scripts/cnpc-ppt.py',
    imagePath: '/opt/cnpc-skills/cnpc-ppt.py',
    script: pptScript,
    input: '{"slides":[{"title":"标题","bullets":["要点一","要点二"]}]}',
    output: 'result.pptx',
  },
] as const;

export const BUILTIN_SKILL_NAMES: Record<string, true> = Object.fromEntries(
  definitions.map((skill) => [skill.name, true] as const),
);

export function builtinSkillSummaries(search = ''): SkillSummary[] {
  const needle = search.trim().toLowerCase();
  return definitions.filter((skill) => !needle || [skill.name, skill.display_name, skill.description]
    .some((value) => value.toLowerCase().includes(needle)))
    .map((skill) => summary(skill));
}

export function builtinSkill(idOrName: string): SkillRecord | null {
  const skill = definitions.find((item) => item.id === idOrName || item.name === idOrName);
  if (!skill) return null;
  return {
    ...summary(skill),
    content: [
      `# ${skill.display_name}`,
      '',
      '仅在用户明确要求生成对应 Office 文件时使用。先根据用户内容生成 UTF-8 JSON 输入文件，再调用 bash 工具执行内置脚本。',
      `输入 JSON 示例：\`${skill.input}\``,
      `执行：\`python ${skill.imagePath} input.json ${skill.output}\``,
      '输入 JSON 与输出文件都必须使用当前工作目录（/workspace）下的相对路径，例如 input.json、result.docx；不要写到 /tmp 或任何绝对路径，只有工作目录下的文件会被同步为当前用户文件。',
      '脚本生成的文件会由沙箱自动同步为当前用户文件。不要访问网络，不要读取未随当前会话提供的文件。',
    ].join('\n'),
    content_sha256: new Bun.CryptoHasher('sha256').update(skill.script).digest('hex'),
    files: [{ path: skill.scriptPath, content: skill.script, size_bytes: Buffer.byteLength(skill.script) }],
  };
}

function summary(skill: typeof definitions[number]): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    display_name: skill.display_name,
    description: skill.description,
    revision: 1,
    source: 'builtin',
    source_url: null,
    created_by: 'system',
    updated_by: 'system',
    created_at: BUILTIN_AT,
    updated_at: BUILTIN_AT,
  };
}
