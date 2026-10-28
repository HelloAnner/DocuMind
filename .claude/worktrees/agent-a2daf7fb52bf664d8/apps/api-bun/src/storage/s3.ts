// 移植自 apps/api-rs/src/storage/mod.rs 的 S3Storage
// 基于 @aws-sdk/client-s3，兼容 MinIO（endpoint / region / path-style 语义对齐 Rust aws-sdk-s3）。
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStorage } from './types.ts';

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    endpoint: string,
    region: string,
    accessKey: string,
    secretKey: string,
    bucket: string,
    forcePathStyle: boolean,
  ) {
    this.client = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
    this.bucket = bucket;
  }

  async put(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
      }), { abortSignal: signal });
    } catch (error) {
      throw contextError(error, 'failed to put object s3://' + this.bucket + '/' + key);
    }
  }

  async get(key: string, signal?: AbortSignal): Promise<Uint8Array> {
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }), { abortSignal: signal });
      if (output.Body === undefined) {
        throw new Error('missing body in get response');
      }
      return await readResponseBody(output.Body, signal);
    } catch (error) {
      throw contextError(error, 'failed to get object s3://' + this.bucket + '/' + key);
    }
  }

  async size(key: string, signal?: AbortSignal): Promise<number> {
    try {
      const output = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }), { abortSignal: signal });
      if (output.ContentLength === undefined) {
        throw new Error('missing content-length in head response');
      }
      return output.ContentLength;
    } catch (error) {
      throw contextError(error, 'failed to head object s3://' + this.bucket + '/' + key);
    }
  }

  async getRange(
    key: string,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // S3 range 是闭区间：bytes=start-end（对齐 Rust end.saturating_sub(1)）
        Range: 'bytes=' + start + '-' + Math.max(0, end - 1),
      }), { abortSignal: signal });
      if (output.Body === undefined) {
        throw new Error('missing body in range response');
      }
      return await readResponseBody(output.Body, signal);
    } catch (error) {
      throw contextError(error, 'failed to get range s3://' + this.bucket + '/' + key);
    }
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }), { abortSignal: signal });
    } catch (error) {
      throw contextError(error, 'failed to delete object s3://' + this.bucket + '/' + key);
    }
  }
}

interface S3ResponseBody {
  transformToWebStream(): ReadableStream<Uint8Array>;
}

export async function readResponseBody(
  body: S3ResponseBody,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const reader = body.transformToWebStream().getReader();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    const reason = signal?.reason instanceof Error
      ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
    void reader.cancel(reason).catch(() => {});
    rejectAbort(reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = signal
        ? await Promise.race([reader.read(), aborted])
        : await reader.read();
      if (item.done) break;
      chunks.push(item.value);
      size += item.value.byteLength;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function contextError(error: unknown, context: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(context + ': ' + detail);
  wrapped.cause = error;
  return wrapped;
}
