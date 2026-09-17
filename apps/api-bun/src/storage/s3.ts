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

  async put(key: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
      }));
    } catch (error) {
      throw contextError(error, 'failed to put object s3://' + this.bucket + '/' + key);
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      if (output.Body === undefined) {
        throw new Error('missing body in get response');
      }
      return new Uint8Array(await output.Body.transformToByteArray());
    } catch (error) {
      throw contextError(error, 'failed to get object s3://' + this.bucket + '/' + key);
    }
  }

  async size(key: string): Promise<number> {
    try {
      const output = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      if (output.ContentLength === undefined) {
        throw new Error('missing content-length in head response');
      }
      return output.ContentLength;
    } catch (error) {
      throw contextError(error, 'failed to head object s3://' + this.bucket + '/' + key);
    }
  }

  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // S3 range 是闭区间：bytes=start-end（对齐 Rust end.saturating_sub(1)）
        Range: 'bytes=' + start + '-' + Math.max(0, end - 1),
      }));
      if (output.Body === undefined) {
        throw new Error('missing body in range response');
      }
      return new Uint8Array(await output.Body.transformToByteArray());
    } catch (error) {
      throw contextError(error, 'failed to get range s3://' + this.bucket + '/' + key);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
    } catch (error) {
      throw contextError(error, 'failed to delete object s3://' + this.bucket + '/' + key);
    }
  }
}

function contextError(error: unknown, context: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(context + ': ' + detail);
  wrapped.cause = error;
  return wrapped;
}
