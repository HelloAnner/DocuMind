import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import type { ObjectStorage } from '../storage/types.ts';
import {
  buildDockerArgs, runBashRunnerAcceptance, runBashSandbox,
} from './sandbox.ts';

const IMAGE = process.env.DOCUMIND_RUNNER_IMAGE;
const integration = IMAGE ? describe : describe.skip;
const TENANT = '00000000-0000-4000-8000-000000000021';
const USER = '00000000-0000-4000-8000-000000000022';
const CONVERSATION = '00000000-0000-4000-8000-000000000023';

integration('real Bash runner acceptance', () => {
  test('executes all Office scripts twice and validates their ZIP packages', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'documind-runner-acceptance-'));
    await chmod(workspace, 0o777);
    try {
      const process = Bun.spawn([
        'docker', ...buildDockerArgs(
          IMAGE!, workspace, 'python /opt/cnpc-skills/smoke.py', `documind-test-${crypto.randomUUID()}`,
        ),
      ], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
      ]);
      expect({ code, stderr, stdout }).toMatchObject({ code: 0, stdout: 'runner-smoke-ok\n' });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('modifies existing XLSX and PPTX in place through the Office skills', async () => {
    const database = fakeDatabase();
    const storage = memoryStorage();
    const check = [
      'from openpyxl import load_workbook',
      'from pptx import Presentation',
      'rows = [[cell.value for cell in row] for row in load_workbook("table.xlsx").active.iter_rows()]',
      'assert rows == [["项目", "数值"], ["产量", 42], ["库存", 7]], rows',
      'assert len(Presentation("deck.pptx").slides._sldIdLst) == 2',
      'print("modify-ok")',
    ].join('\\n');
    const result = await runBashSandbox(request(
      database.sql, storage, crypto.randomUUID(),
      [
        "python /opt/cnpc-skills/cnpc-excel.py <(printf '%s' '{\"sheets\":[{\"name\":\"数据\",\"rows\":[[\"项目\",\"数值\"],[\"产量\",42]]}]}') table.xlsx",
        "python /opt/cnpc-skills/cnpc-excel.py <(printf '%s' '{\"source\":\"table.xlsx\",\"sheets\":[{\"name\":\"数据\",\"mode\":\"append\",\"rows\":[[\"库存\",7]]}]}') table.xlsx",
        "python /opt/cnpc-skills/cnpc-ppt.py <(printf '%s' '{\"slides\":[{\"title\":\"基线\",\"bullets\":[\"基线\"]}]}') deck.pptx",
        "python /opt/cnpc-skills/cnpc-ppt.py <(printf '%s' '{\"source\":\"deck.pptx\",\"slides\":[{\"title\":\"追加\",\"bullets\":[\"追加通过\"]}]}') deck.pptx",
        `CHECK='${check}'`,
        'printf "import sys\\n%b" "$CHECK" > /tmp/check.py',
        'python /tmp/check.py',
      ].join(' && '),
    ));
    expect({ code: result.exit_code, stderr: result.stderr }).toMatchObject({ code: 0 });
    expect(result.stdout).toContain('modify-ok');
    const paths = result.files.map((file) => file.path).sort();
    expect(paths).toHaveLength(2);
    expect(paths[0]).toEndWith('/deck.pptx');
    expect(paths[1]).toEndWith('/table.xlsx');
  });

  test('passes mandatory deployment sync, timeout and symlink acceptance', async () => {
    await expect(runBashRunnerAcceptance(IMAGE!)).resolves.toBeUndefined();
  });

  test('syncs repeated outputs to distinct paths and rejects symlinks', async () => {
    const database = fakeDatabase();
    const storage = memoryStorage();
    const first = await runBashSandbox(request(
      database.sql, storage, crypto.randomUUID(),
      "python /opt/cnpc-skills/cnpc-word.py <(printf '%s' '{\"title\":\"一\"}') result.docx",
    ));
    const second = await runBashSandbox(request(
      database.sql, storage, crypto.randomUUID(),
      "python /opt/cnpc-skills/cnpc-word.py <(printf '%s' '{\"title\":\"二\"}') result.docx",
    ));
    expect(first.files[0]!.path).not.toBe(second.files[0]!.path);
    expect(first.files[0]!.path).toEndWith('/result.docx');
    expect(second.files[0]!.path).toEndWith('/result.docx');
    expect(database.links).toHaveLength(2);
    expect(storage.objects.size).toBe(2);

    await expect(runBashSandbox(request(
      database.sql, storage, crypto.randomUUID(), 'ln -s /etc/passwd leak.txt',
    ))).rejects.toThrow('symlink output rejected');
  });

  test('kills and removes a timed-out container before synchronizing', async () => {
    const seeded = seedOriginalFile();
    // Integration exception: this deliberately exercises the host timer and Docker kill path.
    const result = await runBashSandbox({
      ...request(
        seeded.database.sql, seeded.storage, crypto.randomUUID(),
        'printf partial > table.xlsx; sleep 5; printf late > late.txt',
        [seeded.fileId],
      ),
      timeoutSeconds: 1,
    });
    expect(result.exit_code).toBe(124);
    expect(result.files).toEqual([]);
    expect(result.stderr).toContain('工作区改动未同步：执行超时');
    expect(seeded.database.links).toEqual([]);
    expect(seeded.database.updates).toEqual([]);
    expect([...seeded.storage.objects.keys()]).toEqual([seeded.storageKey]);
    expect(new TextDecoder().decode(seeded.storage.objects.get(seeded.storageKey)!))
      .toBe('original-bytes');
  });

  test('keeps the uploaded original untouched when the command exits non-zero', async () => {
    const seeded = seedOriginalFile();
    const result = await runBashSandbox(request(
      seeded.database.sql, seeded.storage, crypto.randomUUID(),
      'printf half-written > table.xlsx; printf scratch > extra.txt; exit 3',
      [seeded.fileId],
    ));
    expect(result.exit_code).toBe(3);
    expect(result.files).toEqual([]);
    expect(result.stderr).toContain('工作区改动未同步：命令退出码 3');
    expect(seeded.database.updates).toEqual([]);
    expect(seeded.database.links).toEqual([]);
    expect([...seeded.storage.objects.keys()]).toEqual([seeded.storageKey]);
    expect(new TextDecoder().decode(seeded.storage.objects.get(seeded.storageKey)!))
      .toBe('original-bytes');
  });

  test('keeps the uploaded original untouched when output exceeds the cap', async () => {
    const seeded = seedOriginalFile();
    const result = await runBashSandbox(request(
      seeded.database.sql, seeded.storage, crypto.randomUUID(),
      `printf partial > table.xlsx; python -c "import sys; sys.stdout.write('a' * 2000000)"`,
      [seeded.fileId],
    ));
    expect(result.files).toEqual([]);
    expect(result.stdout).toContain('输出已截断');
    expect(result.stderr).toContain('工作区改动未同步：输出超限');
    expect(seeded.database.updates).toEqual([]);
    expect(seeded.database.links).toEqual([]);
    expect([...seeded.storage.objects.keys()]).toEqual([seeded.storageKey]);
  });
});

function request(
  sql: Sql,
  storage: ObjectStorage,
  messageId: string,
  command: string,
  fileIds: string[] = [],
) {
  return {
    sql,
    storage,
    tenantId: TENANT,
    userId: USER,
    conversationId: CONVERSATION,
    assistantMessageId: messageId,
    fileIds,
    command,
    options: { image: IMAGE!, maxTimeoutSeconds: 30 },
  };
}

/** 预置一个已上传的会话文件（storage 里放原始字节，DB 能按 id 查回），用于验证失败时不被半写覆盖。 */
function seedOriginalFile() {
  const fileId = crypto.randomUUID();
  const storageKey = `tenants/${TENANT}/users/${USER}/files/${fileId}/v1/table.xlsx`;
  const storage = memoryStorage();
  storage.objects.set(storageKey, new TextEncoder().encode('original-bytes'));
  const database = fakeDatabase({
    id: fileId,
    tenant_id: TENANT,
    user_id: USER,
    conversation_id: CONVERSATION,
    name: 'table.xlsx',
    path: 'table.xlsx',
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size_bytes: 14,
    source: 'upload',
    storage_key: storageKey,
    extracted_text: null,
    extraction_truncated: false,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return { database, storage, fileId, storageKey };
}

function memoryStorage(): ObjectStorage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async get(key) { const value = objects.get(key); if (!value) throw new Error('missing'); return value; },
    async size(key) { return (await this.get(key)).byteLength; },
    async getRange(key, start, end) { return (await this.get(key)).slice(start, end); },
    async delete(key) { objects.delete(key); },
  };
}

function fakeDatabase(seededFile?: Record<string, unknown>): {
  sql: Sql;
  links: string[];
  updates: unknown[];
} {
  const cleanup = new Set<string>();
  const paths = new Set<string>();
  const links: string[] = [];
  const updates: unknown[] = [];
  const sql = {
    async unsafe(query: string, values: unknown[]) {
      if (query.includes('FROM user_file WHERE id = $1')) {
        return seededFile && values[0] === seededFile.id ? [seededFile] : [];
      }
      if (query.includes('INSERT INTO user_file_object_cleanup')) {
        cleanup.add(String(values[0]));
        return [{ id: cleanup.size }];
      }
      throw new Error(`unexpected SQL outside transaction: ${query}`);
    },
    async begin(callback: (tx: { unsafe: (query: string, values: unknown[]) => Promise<any[]> }) => Promise<unknown>) {
      const nextCleanup = new Set(cleanup);
      const nextPaths = new Set(paths);
      const nextLinks = [...links];
      const tx = {
        async unsafe(query: string, values: unknown[]) {
          if (query.startsWith('SELECT storage_key')) {
            return nextCleanup.has(String(values[0]))
              ? [{ storage_key: values[0] }] : [];
          }
          if (query.includes('UPDATE user_file SET size_bytes')) {
            updates.push(values);
            return seededFile ? [{ ...seededFile, size_bytes: values[0], source: 'sandbox' }] : [];
          }
          if (query.includes('INSERT INTO user_file_object_cleanup')) {
            return [];
          }
          if (query.includes('INSERT INTO user_file\n')) {
            const path = String(values[5]);
            if (nextPaths.has(path)) throw Object.assign(new Error('duplicate path'), { code: '23505' });
            nextPaths.add(path);
            return [{
              id: values[0], tenant_id: values[1], user_id: values[2], conversation_id: values[3],
              name: values[4], path, mime_type: values[6], size_bytes: values[7], source: values[8],
              storage_key: values[9], extracted_text: null, extraction_truncated: false,
              created_at: new Date(), updated_at: new Date(),
            }];
          }
          if (query.startsWith('DELETE FROM user_file_object_cleanup')) {
            nextCleanup.delete(String(values[0]));
            return [];
          }
          if (query.includes('INSERT INTO conversation_message_file')) {
            nextLinks.push(`${String(values[0])}:${String(values[1])}`);
            return [];
          }
          throw new Error(`unexpected transaction SQL: ${query}`);
        },
      };
      const result = await callback(tx);
      cleanup.clear();
      for (const value of nextCleanup) cleanup.add(value);
      paths.clear();
      for (const value of nextPaths) paths.add(value);
      links.splice(0, links.length, ...nextLinks);
      return result;
    },
  } as unknown as Sql;
  return { sql, links, updates };
}
