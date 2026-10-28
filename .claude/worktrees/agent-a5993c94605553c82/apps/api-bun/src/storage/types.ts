// 移植自 apps/api-rs/src/storage/mod.rs 的 ObjectStorage 端口
export interface ObjectStorage {
  put(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<Uint8Array>;
  size(key: string, signal?: AbortSignal): Promise<number>;
  /** 读取 [start, end) 字节范围 */
  getRange(key: string, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}
