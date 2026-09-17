// 移植自 apps/api-rs/src/storage/mod.rs 的 ObjectStorage 端口
export interface ObjectStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  size(key: string): Promise<number>;
  /** 读取 [start, end) 字节范围 */
  getRange(key: string, start: number, end: number): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}
