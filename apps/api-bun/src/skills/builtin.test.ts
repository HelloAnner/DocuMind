import { describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { getSkill, listSkills } from '../api/admin_skills.ts';

const emptySql = (async () => []) as unknown as Sql;

describe('CNPC built-in skills', () => {
  test('every tenant discovers and reads the three immutable office skills', async () => {
    for (const tenantId of [crypto.randomUUID(), crypto.randomUUID()]) {
      const listed = await listSkills(emptySql, tenantId);
      expect(listed.map((skill) => skill.name)).toEqual(['cnpc-word', 'cnpc-excel', 'cnpc-ppt']);
      for (const name of ['cnpc-word', 'cnpc-excel', 'cnpc-ppt']) {
        const skill = await getSkill(emptySql, tenantId, name);
        expect(skill.source).toBe('builtin');
        expect(skill.content).toContain('bash');
        expect(skill.files).toHaveLength(1);
        expect(skill.files[0]!.content).toStartWith('#!/usr/bin/env python3');
      }
      for (const name of ['cnpc-excel', 'cnpc-ppt']) {
        const skill = await getSkill(emptySql, tenantId, name);
        expect(skill.content).toContain('"source"');
        expect(skill.content).toContain('原地修改');
      }
    }
  });
});
