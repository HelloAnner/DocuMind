import { expect, test } from 'bun:test';
import { withObjectStorageTimeout } from '../files/service.ts';
import { readResponseBody } from './s3.ts';

test('read timeout cancels stalled S3 response body consumption', async () => {
  let cancellations = 0;
  const body = {
    transformToWebStream() {
      return new ReadableStream<Uint8Array>({
        cancel() { cancellations += 1; },
      });
    },
  };

  await expect(withObjectStorageTimeout(
    'get', (signal) => readResponseBody(body, signal), 5,
  )).rejects.toThrow('object storage get timed out after 5ms');
  expect(cancellations).toBe(1);
});
