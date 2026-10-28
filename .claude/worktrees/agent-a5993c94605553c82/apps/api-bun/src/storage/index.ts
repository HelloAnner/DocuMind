// 移植自 apps/api-rs/src/storage/mod.rs 的 build_storage。
// 当 OBJECT_STORAGE_ENDPOINT / ACCESS_KEY / SECRET_KEY 同时非空时使用 S3/MinIO；
// 否则回退到本地文件系统（blobStorageDir）。
import type { AppConfig } from '../config.ts';
import type { ObjectStorage } from './types.ts';
import { S3Storage } from './s3.ts';
import { LocalStorage } from './local.ts';

export type { ObjectStorage } from './types.ts';
export { S3Storage } from './s3.ts';
export { LocalStorage } from './local.ts';

export function buildStorage(config: AppConfig): ObjectStorage {
  const endpoint = nonEmpty(config.objectStorageEndpoint);
  const accessKey = nonEmpty(config.objectStorageAccessKey);
  const secretKey = nonEmpty(config.objectStorageSecretKey);

  if (endpoint !== null && accessKey !== null && secretKey !== null) {
    console.log(
      '[documind][storage] using S3/MinIO object storage, endpoint='
      + endpoint + ', bucket=' + config.objectStorageBucket,
    );
    return new S3Storage(
      endpoint,
      config.objectStorageRegion,
      accessKey,
      secretKey,
      config.objectStorageBucket,
      config.objectStorageForcePathStyle,
    );
  }
  console.log(
    '[documind][storage] object storage not fully configured, falling back to local file storage, blob_dir='
    + config.blobStorageDir,
  );
  return new LocalStorage(config.blobStorageDir);
}

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  if (value.trim() === '') return null;
  return value;
}
