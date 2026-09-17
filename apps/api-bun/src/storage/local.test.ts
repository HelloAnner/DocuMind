// LocalStorage 基本行为测试（Rust 端 storage/mod.rs 无 #[cfg(test)]，为本地实现补测试）
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorage } from './local.ts';

let dir: string;
let storage: LocalStorage;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'documind-storage-'));
  storage = new LocalStorage(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LocalStorage', () => {
  test('put/get round trip, including nested keys', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await storage.put('a/b/c.bin', bytes);
    expect(await storage.get('a/b/c.bin')).toEqual(bytes);
  });

  test('size returns byte length', async () => {
    await storage.put('f.bin', new Uint8Array(7));
    expect(await storage.size('f.bin')).toBe(7);
  });

  test('getRange reads [start, end)', async () => {
    await storage.put('r.bin', new Uint8Array([10, 11, 12, 13, 14]));
    expect(await storage.getRange('r.bin', 1, 4)).toEqual(new Uint8Array([11, 12, 13]));
  });

  test('delete is idempotent for missing keys', async () => {
    await storage.put('d.bin', new Uint8Array([1]));
    await storage.delete('d.bin');
    await storage.delete('d.bin');
    await expect(storage.get('d.bin')).rejects.toThrow();
  });
});
