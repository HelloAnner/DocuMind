import { describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import type { StoredUserFile } from '../models/user_file.ts';
import type { ObjectStorage } from '../storage/types.ts';
import {
  createStoredUserFile,
  drainObjectCleanup,
  updateStoredUserFile,
  withObjectStorageTimeout,
} from './service.ts';

const TENANT = '00000000-0000-4000-8000-000000000011';
const USER = '00000000-0000-4000-8000-000000000012';
const CONVERSATION = '00000000-0000-4000-8000-000000000013';
const MESSAGE = '00000000-0000-4000-8000-000000000014';
const FILE = '00000000-0000-4000-8000-000000000015';
const OLD_KEY = `tenants/${TENANT}/users/${USER}/files/${FILE}/old/private.txt`;

type TestRow = Record<string, unknown>;
type TestRows = TestRow[];

function input(messageId?: string) {
  return {
    tenantId: TENANT,
    userId: USER,
    conversationId: CONVERSATION,
    path: 'private.txt',
    mimeType: 'text/plain; charset=utf-8',
    source: 'upload' as const,
    bytes: new TextEncoder().encode('private'),
    ...(messageId ? { messageId } : {}),
  };
}

describe('user file object consistency', () => {
  test('stalled object upload never holds a SQL transaction', async () => {
    let transactionStarts = 0;
    let rejectPut!: (error: Error) => void;
    let putStarted!: () => void;
    const putStartedGate = new Promise<void>((resolve) => { putStarted = resolve; });
    const sql = {
      async unsafe(query: string) {
        if (query.startsWith('INSERT INTO user_file_object_cleanup')) return [{ id: 1 }];
        throw new Error(`unexpected SQL: ${query}`);
      },
      async begin() { transactionStarts += 1; throw new Error('transaction must not start'); },
    } as unknown as Sql;
    const storage = storageStub({
      put: async () => {
        putStarted();
        await new Promise<void>((_resolve, reject) => { rejectPut = reject; });
      },
    });

    const pending = createStoredUserFile(sql, storage, input());
    await putStartedGate;
    expect(transactionStarts).toBe(0);
    rejectPut(new Error('put stopped'));
    await expect(pending).rejects.toThrow('put stopped');
    expect(transactionStarts).toBe(0);
  });

  test('upload publishes only after the owned pending reservation is locked', async () => {
    let inTransaction = false;
    let reservationToken = '';
    const sql = {
      async unsafe(query: string, values: unknown[]) {
        if (query.startsWith('INSERT INTO user_file_object_cleanup')) {
          reservationToken = String(values[1]);
          return [{ id: 1 }];
        }
        throw new Error(`unexpected SQL: ${query}`);
      },
      async begin(callback: (tx: { unsafe: (query: string, values: unknown[]) => Promise<TestRows> }) => Promise<unknown>) {
        inTransaction = true;
        try {
          return await callback({
            async unsafe(query: string, values: unknown[]) {
              if (query.startsWith('SELECT storage_key')) {
                return values[1] === reservationToken ? [{ storage_key: values[0] }] : [];
              }
              if (query.includes('INSERT INTO user_file\n')) return storedRow(values);
              if (query.startsWith('DELETE FROM user_file_object_cleanup')) return [];
              if (query.includes('INSERT INTO conversation_message_file')) return [];
              throw new Error(`unexpected transaction SQL: ${query}`);
            },
          });
        } finally {
          inTransaction = false;
        }
      },
    } as unknown as Sql;
    const storage = storageStub({
      put: async () => { expect(inTransaction).toBeFalse(); },
    });

    const file = await createStoredUserFile(sql, storage, input(MESSAGE));
    expect(file.storage_key).toContain('/private.txt');
  });

  test('version update uploads outside SQL and swaps metadata in a short transaction', async () => {
    let inTransaction = false;
    let reservationToken = '';
    const sql = {
      async unsafe(query: string, values: unknown[]) {
        if (query.startsWith('INSERT INTO user_file_object_cleanup')) {
          reservationToken = String(values[1]);
          return [{ id: 1 }];
        }
        throw new Error(`unexpected SQL: ${query}`);
      },
      async begin(callback: (tx: { unsafe: (query: string, values: unknown[]) => Promise<TestRows> }) => Promise<unknown>) {
        inTransaction = true;
        try {
          return await callback({
            async unsafe(query: string, values: unknown[]) {
              if (query.startsWith('WITH due AS')) return [];
              if (query.startsWith('SELECT storage_key')) {
                return values[1] === reservationToken ? [{ storage_key: values[0] }] : [];
              }
              if (query.startsWith('UPDATE user_file SET size_bytes')) {
                return [{
                  ...storedFile(OLD_KEY),
                  storage_key: values[2],
                  size_bytes: values[0],
                  created_at: new Date(),
                  updated_at: new Date(),
                }];
              }
              if (query.startsWith('INSERT INTO user_file_object_cleanup')) return [];
              if (query.startsWith('DELETE FROM user_file_object_cleanup')) return [];
              if (query.includes('INSERT INTO conversation_message_file')) return [];
              throw new Error(`unexpected transaction SQL: ${query}`);
            },
          });
        } finally {
          inTransaction = false;
        }
      },
    } as unknown as Sql;
    const storage = storageStub({ put: async () => { expect(inTransaction).toBeFalse(); } });

    const updated = await updateStoredUserFile(
      sql, storage, storedFile(OLD_KEY), new TextEncoder().encode('new'), MESSAGE,
    );
    expect(updated.storage_key).not.toBe(OLD_KEY);
  });

  test('object timeout aborts the request and returns before the lease', async () => {
    let aborted = false;
    await expect(withObjectStorageTimeout('put', async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        }, { once: true });
      });
    }, 5)).rejects.toThrow('object storage put timed out after 5ms');
    expect(aborted).toBeTrue();
  });

  test('read timeout aborts storage work instead of leaving it stuck', async () => {
    let activeReads = 0;
    let aborted = false;
    const storage = storageStub({
      async get(_key, signal) {
        activeReads += 1;
        try {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            }, { once: true });
          });
          return new Uint8Array();
        } finally {
          activeReads -= 1;
        }
      },
    });

    await expect(withObjectStorageTimeout(
      'get', (signal) => storage.get('stalled', signal), 5,
    )).rejects.toThrow('object storage get timed out after 5ms');
    expect(aborted).toBeTrue();
    expect(activeReads).toBe(0);
  });
  test('delete timeout runs outside SQL and reschedules the claimed row', async () => {

    let inTransaction = false;
    let rescheduled = false;
    let deleteAborted = false;
    let claimedLimit = 0;
    const sql = cleanupSql(async (query, values) => {
      if (query.startsWith('WITH due AS')) {
        claimedLimit = Number(values[0]);
        return [{ id: 1, storage_key: OLD_KEY, attempts: 0 }];
      }
      if (query.startsWith('SELECT storage_key FROM user_file')) return [];
      if (query.startsWith('UPDATE user_file_object_cleanup')) {
        rescheduled = true;
        return [];
      }
      throw new Error(`unexpected SQL: ${query}`);
    }, (active) => { inTransaction = active; });
    const storage = storageStub({
      delete: async (_key, signal) => {
        expect(inTransaction).toBeFalse();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            deleteAborted = true;
            reject(new Error('aborted'));
          }, { once: true });
        });
      },
    });

    expect(await drainObjectCleanup(sql, storage, 1_000, 5)).toBe(0);
    expect(claimedLimit).toBe(25);
    expect(deleteAborted).toBeTrue();
    expect(rescheduled).toBeTrue();
  });

  test('overlapping drains share an in-process mutex', async () => {
    let claimCalls = 0;
    let deleteCalls = 0;
    let releaseDelete!: () => void;
    let deleteStarted!: () => void;
    const deleteStartedGate = new Promise<void>((resolve) => { deleteStarted = resolve; });
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const sql = cleanupSql(async (query) => {
      if (query.startsWith('WITH due AS')) {
        claimCalls += 1;
        return [{ id: 1, storage_key: OLD_KEY, attempts: 0 }];
      }
      if (query.startsWith('SELECT storage_key FROM user_file')) return [];
      if (query.startsWith('DELETE FROM user_file_object_cleanup')) return [];
      throw new Error(`unexpected SQL: ${query}`);
    });
    const storage = storageStub({
      delete: async () => {
        deleteCalls += 1;
        deleteStarted();
        await deleteGate;
      },
    });

    const first = drainObjectCleanup(sql, storage);
    await deleteStartedGate;
    expect(await drainObjectCleanup(sql, storage)).toBe(0);
    expect(claimCalls).toBe(1);
    releaseDelete();
    expect(await first).toBe(1);
    expect(deleteCalls).toBe(1);
  });

  test('cleaner claim wins an expired lease and the writer rejects publication', async () => {
    let reservationToken: string | null = null;
    let claimToken: string | null = null;
    let reservationExists = false;
    let inTransaction = false;
    const objects = new Map<string, Uint8Array>();
    let releasePut!: () => void;
    let putStarted!: () => void;
    let releaseDelete!: () => void;
    let deleteStarted!: () => void;
    const putGate = new Promise<void>((resolve) => { releasePut = resolve; });
    const putStartedGate = new Promise<void>((resolve) => { putStarted = resolve; });
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const deleteStartedGate = new Promise<void>((resolve) => { deleteStarted = resolve; });
    const sql = {
      async unsafe(query: string, values: unknown[]) {
        if (query.startsWith('INSERT INTO user_file_object_cleanup')) {
          reservationExists = true;
          reservationToken = String(values[1]);
          return [{ id: 1 }];
        }
        throw new Error(`unexpected outer SQL: ${query}`);
      },
      async begin(callback: (tx: { unsafe: (query: string, values: unknown[]) => Promise<TestRows> }) => Promise<unknown>) {
        inTransaction = true;
        try {
          return await callback({
            async unsafe(query: string, values: unknown[]) {
              if (query.startsWith('WITH due AS')) {
                claimToken = String(values[1]);
                reservationToken = null;
                return [{ id: 1, storage_key: [...objects.keys()][0] ?? 'pending-key', attempts: 0 }];
              }
              if (query.startsWith('SELECT storage_key FROM user_file')) return [];
              if (query.startsWith('SELECT storage_key FROM user_file_object_cleanup')) {
                return reservationExists && reservationToken === values[1] && claimToken === null
                  ? [{ storage_key: values[0] }] : [];
              }
              if (query.startsWith('DELETE FROM user_file_object_cleanup')) {
                reservationExists = false;
                return [];
              }
              throw new Error(`unexpected transaction SQL: ${query}`);
            },
          });
        } finally {
          inTransaction = false;
        }
      },
    } as unknown as Sql;
    let pendingKey = '';
    const storage = storageStub({
      put: async (key, bytes) => {
        expect(inTransaction).toBeFalse();
        pendingKey = key;
        putStarted();
        await putGate;
        objects.set(key, new Uint8Array(bytes));
      },
      delete: async () => {
        expect(inTransaction).toBeFalse();
        deleteStarted();
        await deleteGate;
        objects.delete(pendingKey);
      },
    });

    const writer = createStoredUserFile(sql, storage, input());
    await putStartedGate;
    const cleaner = drainObjectCleanup(sql, storage);
    await deleteStartedGate;
    releasePut();
    await expect(writer).rejects.toThrow('reservation claimed or missing');
    releaseDelete();
    expect(await cleaner).toBe(1);
    expect(objects.size).toBe(0);
    expect(reservationExists).toBeFalse();
  });

  test('referenced objects are never deleted and cleanup completion is transactional', async () => {
    let deleteCalls = 0;
    let cleanupCompleted = false;
    const sql = cleanupSql(async (query) => {
      if (query.startsWith('WITH due AS')) return [{ id: 1, storage_key: OLD_KEY, attempts: 0 }];
      if (query.startsWith('SELECT storage_key FROM user_file')) return [{ storage_key: OLD_KEY }];
      if (query.startsWith('DELETE FROM user_file_object_cleanup')) {
        cleanupCompleted = true;
        return [];
      }
      throw new Error(`unexpected SQL: ${query}`);
    });
    const storage = storageStub({ delete: async () => { deleteCalls += 1; } });

    expect(await drainObjectCleanup(sql, storage)).toBe(0);
    expect(deleteCalls).toBe(0);
    expect(cleanupCompleted).toBeTrue();
  });
});

function cleanupSql(
  execute: (query: string, values: unknown[]) => Promise<TestRows>,
  transactionState: (active: boolean) => void = () => {},
): Sql {
  return {
    async begin(callback: (tx: { unsafe: typeof execute }) => Promise<unknown>) {
      transactionState(true);
      try {
        return await callback({ unsafe: execute });
      } finally {
        transactionState(false);
      }
    },
  } as unknown as Sql;
}

function storageStub(overrides: Partial<ObjectStorage>): ObjectStorage {
  return {
    async put() {},
    async get() { throw new Error('missing'); },
    async size() { return 0; },
    async getRange() { return new Uint8Array(); },
    async delete() {},
    ...overrides,
  };
}

function storedRow(values: unknown[]): TestRows {
  return [{
    id: values[0], tenant_id: values[1], user_id: values[2], conversation_id: values[3],
    name: values[4], path: values[5], mime_type: values[6], size_bytes: values[7],
    source: values[8], storage_key: values[9], extracted_text: null,
    extraction_truncated: false, created_at: new Date(), updated_at: new Date(),
  }];
}

function storedFile(storageKey: string): StoredUserFile {
  return {
    id: FILE,
    tenant_id: TENANT,
    user_id: USER,
    conversation_id: CONVERSATION,
    name: 'private.txt',
    path: 'private.txt',
    mime_type: 'text/plain; charset=utf-8',
    size_bytes: 7,
    source: 'upload',
    storage_key: storageKey,
    extracted_text: null,
    extraction_truncated: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    download_url: `/api/files/${FILE}/download`,
  };
}
