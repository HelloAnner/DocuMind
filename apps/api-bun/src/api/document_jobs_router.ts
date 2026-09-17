// 移植自 apps/api-rs/src/api/document_jobs.rs 的 router()
import { Hono } from 'hono';
import type { AppEnv } from '../http/types.ts';
import { listJobs, getJob } from './document_jobs.ts';

export function documentJobsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/admin/document-jobs', listJobs);
  router.get('/api/admin/document-jobs/:job_id', getJob);
  return router;
}
