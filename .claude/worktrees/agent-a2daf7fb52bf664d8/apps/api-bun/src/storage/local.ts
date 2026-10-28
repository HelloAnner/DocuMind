// 移植自 apps/api-rs/src/storage/mod.rs 的 LocalStorage
// key 直接映射为 root 目录下的相对路径。
import { mkdir, open, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ObjectStorage } from './types.ts';

export class LocalStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private keyToPath(key: string): string {
    return join(this.root, key);
  }

  async put(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const path = this.keyToPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    signal?.throwIfAborted();
  }

  async get(key: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const path = this.keyToPath(key);
    const buffer = await readFile(path, { signal });
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async size(key: string, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const path = this.keyToPath(key);
    const meta = await stat(path);
    signal?.throwIfAborted();
    return meta.size;
  }

  async getRange(
    key: string,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const path = this.keyToPath(key);
    const handle = await open(path, 'r');
    try {
      const length = Math.max(0, end - start);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      signal?.throwIfAborted();
      return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
    } finally {
      await handle.close();
    }
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const path = this.keyToPath(key);
    try {
      await rm(path);
      signal?.throwIfAborted();
    } catch (error) {
      if (isNotFound(error)) return;
      console.error('[documind][storage] failed to delete local file ' + path + ':', error);
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
