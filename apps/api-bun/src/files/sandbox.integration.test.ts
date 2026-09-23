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
    const database = fakeDatabase();
    const storage = memoryStorage();
    // Integration exception: this deliberately exercises the host timer and Docker kill path.
    const result = await runBashSandbox({
      ...request(database.sql, storage, crypto.randomUUID(), 'sleep 5; printf late > late.txt'),
      timeoutSeconds: 1,
    });
    expect(result.exit_code).toBe(124);
    expect(result.files).toEqual([]);
    expect(database.links).toEqual([]);
  });
});

function request(sql: Sql, storage: ObjectStorage, messageId: string, command: string) {
  return {
    sql,
    storage,
    tenantId: TENANT,
    userId: USER,
    conversationId: CONVERSATION,
    assistantMessageId: messageId,
    fileIds: [],
    command,
    options: { image: IMAGE!, maxTimeoutSeconds: 30 },
  };
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

function fakeDatabase(): { sql: Sql; links: string[] } {
  const cleanup = new Set<string>();
  const paths = new Set<string>();
  const links: string[] = [];
  const sql = {
    async unsafe(query: string, values: unknown[]) {
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
  return { sql, links };
}
