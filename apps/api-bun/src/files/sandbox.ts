import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Sql } from 'postgres';
import type { StoredUserFile, UserFile } from '../models/user_file.ts';
import type { ObjectStorage } from '../storage/types.ts';
import {
  createStoredUserFile,
  getOwnedUserFile,
  MAX_USER_FILE_BYTES,
  mimeTypeForPath,
  normalizeUserFilePath,
  publicUserFile,
  updateStoredUserFile,
  withObjectStorageTimeout,
} from './service.ts';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_FILES = 100;
const MAX_OUTPUT_TOTAL_BYTES = 100 * 1024 * 1024;

export interface BashSandboxOptions {
  image: string;
  maxTimeoutSeconds: number;
}

export interface BashSandboxRequest {
  sql: Sql;
  storage: ObjectStorage;
  tenantId: string;
  userId: string;
  conversationId: string;
  assistantMessageId: string;
  fileIds: string[];
  command: string;
  timeoutSeconds?: number;
  options: BashSandboxOptions;
}

export interface BashSandboxResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  files: UserFile[];
}

export function buildDockerArgs(
  image: string,
  workspace: string,
  command: string,
  containerName: string,
): string[] {
  return [
    'run', '--rm',
    '--name', containerName,
    '--network', 'none',
    '--user', '65532:65532',
    '--read-only',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--cpus', '1',
    '--memory', '512m',
    '--pids-limit', '64',
    '--ulimit', 'nofile=128:128',
    '--ulimit', `fsize=${MAX_USER_FILE_BYTES}:${MAX_USER_FILE_BYTES}`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--mount', `type=bind,src=${workspace},dst=/workspace`,
    '--workdir', '/workspace',
    '--entrypoint', '/bin/bash',
    image, '--noprofile', '--norc', '-c', command,
  ];
}

export async function runBashSandbox(request: BashSandboxRequest): Promise<BashSandboxResult> {
  const command = request.command.trim();
  if (!command || command.length > 20_000) throw new Error('bash command must be 1-20000 characters');
  const timeoutSeconds = request.timeoutSeconds ?? request.options.maxTimeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1
    || timeoutSeconds > request.options.maxTimeoutSeconds) {
    throw new Error(`timeout_seconds must be an integer between 1 and ${request.options.maxTimeoutSeconds}`);
  }
  const workspace = await mkdtemp(join(tmpdir(), 'documind-sandbox-'));
  const originals = new Map<string, { file: StoredUserFile; digest: string }>();
  try {
    await chmod(workspace, 0o777);
    for (const fileId of request.fileIds) {
      const file = await getOwnedUserFile(request.sql, request.tenantId, request.userId, fileId);
      if (file.conversation_id !== request.conversationId) throw new Error('file is not associated with this conversation');
      const bytes = await withObjectStorageTimeout(
        'get', (signal) => request.storage.get(file.storage_key, signal),
      );
      const path = workspacePath(workspace, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o777 });
      await chmod(dirname(path), 0o777);
      await writeFile(path, bytes, { mode: 0o666 });
      await chmod(path, 0o666);
      originals.set(file.path, { file, digest: digest(bytes) });
    }
    const containerName = `documind-${randomUUID()}`;

    const process = Bun.spawn([
      'docker', ...buildDockerArgs(request.options.image, workspace, command, containerName),
    ], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    let timedOut = false;
    const outputState = { used: 0, exceeded: false };
    let shutdown: Promise<void> | null = null;
    const stop = () => {
      if (shutdown) return;
      shutdown = ensureDockerContainerRemoved(containerName, true);
      void shutdown.catch(() => {
        try { process.kill('SIGKILL'); } catch {}
      });
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSeconds * 1000);
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(process.stdout, outputState, stop),
      readBounded(process.stderr, outputState, stop),
      process.exited,
    ]).finally(() => clearTimeout(timer));
    await (shutdown ?? ensureDockerContainerRemoved(containerName, false));

    // 只有正常结束才同步工作区改动：命令失败（非零退出/超时/输出超限被杀）时工作区里
    // 可能是半写状态，同步回去会覆盖用户已上传的原文件，属于数据完整性事故。
    const unsynced = unsyncedReason(timedOut, outputState.exceeded, exitCode);
    const files = unsynced === null ? await synchronizeWorkspace(request, workspace, originals) : [];
    const suffix = outputState.exceeded ? '\n[输出已截断：stdout+stderr 最多 1 MB]' : '';
    return {
      exit_code: timedOut ? 124 : exitCode,
      stdout: stdout + (outputState.exceeded ? suffix : ''),
      stderr: stderr + (timedOut ? `\n[执行超时：${timeoutSeconds} 秒]` : '')
        + (unsynced === null ? '' : `\n[工作区改动未同步：${unsynced}]`),
      files,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** 工作区改动不同步的原因；null 表示正常结束（exit=0）可以同步回用户文件。 */
export function unsyncedReason(
  timedOut: boolean,
  outputExceeded: boolean,
  exitCode: number,
): string | null {
  if (timedOut) return '执行超时';
  if (outputExceeded) return '输出超限';
  if (exitCode !== 0) return `命令退出码 ${exitCode}`;
  return null;
}

async function synchronizeWorkspace(
  request: BashSandboxRequest,
  workspace: string,
  originals: Map<string, { file: StoredUserFile; digest: string }>,
): Promise<UserFile[]> {
  const paths = await regularWorkspaceFiles(workspace);
  const outputs = await readWorkspaceOutputs(workspace, paths);
  const changed: UserFile[] = [];
  for (const { path, bytes } of outputs) {
    const original = originals.get(path);
    if (original?.digest === digest(bytes)) continue;
    const storedPath = original ? path : sandboxOutputPath(request, path);
    const stored = original
      ? await updateStoredUserFile(
        request.sql, request.storage, original.file, bytes, request.assistantMessageId,
      )
      : await createStoredUserFile(request.sql, request.storage, {
        tenantId: request.tenantId,
        userId: request.userId,
        conversationId: request.conversationId,
        path: storedPath,
        mimeType: mimeTypeForPath(path),
        source: 'sandbox',
        bytes,
        messageId: request.assistantMessageId,
      });
    changed.push(publicUserFile(stored));
  }
  return changed;
}
export function sandboxOutputPath(
  request: Pick<BashSandboxRequest, 'conversationId' | 'assistantMessageId'>,
  path: string,
): string {
  return normalizeUserFilePath(
    `generated/${request.conversationId}/${request.assistantMessageId}/${path}`,
    path,
  );
}

export async function runBashRunnerAcceptance(image: string): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'documind-runner-deploy-'));
  try {
    await chmod(workspace, 0o777);
    const synced = await runAcceptanceContainer(
      image, workspace, 'printf runner-sync-ok > result.txt', 10_000,
    );
    if (synced.timedOut || synced.exitCode !== 0) {
      throw new Error(`runner workspace sync command failed: ${synced.stderr}`);
    }
    const outputs = await readWorkspaceOutputs(workspace, await regularWorkspaceFiles(workspace));
    if (new TextDecoder().decode(outputs.find((item) => item.path === 'result.txt')?.bytes)
      !== 'runner-sync-ok') {
      throw new Error('runner workspace sync acceptance failed');
    }

    const timed = await runAcceptanceContainer(
      image, workspace, 'sleep 30; printf late > late.txt', 1_000,
    );
    if (!timed.timedOut || (await regularWorkspaceFiles(workspace)).includes('late.txt')) {
      throw new Error('runner timeout shutdown acceptance failed');
    }

    const linked = await runAcceptanceContainer(
      image, workspace, 'ln -s /etc/passwd leak.txt', 10_000,
    );
    if (linked.timedOut || linked.exitCode !== 0) {
      throw new Error(`runner symlink setup failed: ${linked.stderr}`);
    }
    try {
      await regularWorkspaceFiles(workspace);
    } catch (error) {
      if (error instanceof Error && error.message.includes('symlink output rejected')) return;
      throw error;
    }
    throw new Error('runner symlink rejection acceptance failed');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runAcceptanceContainer(
  image: string,
  workspace: string,
  command: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stderr: string; timedOut: boolean }> {
  const containerName = `documind-acceptance-${randomUUID()}`;
  const process = Bun.spawn([
    'docker', ...buildDockerArgs(image, workspace, command, containerName),
  ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  let shutdown: Promise<void> | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    shutdown = ensureDockerContainerRemoved(containerName, true);
    void shutdown.catch(() => {
      try { process.kill('SIGKILL'); } catch {}
    });
  }, timeoutMs);
  const [, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]).finally(() => clearTimeout(timer));
  await (shutdown ?? ensureDockerContainerRemoved(containerName, false));
  return { exitCode, stderr, timedOut };
}


interface DockerCommandResult {
  exitCode: number;
  stderr: string;
}

export async function ensureDockerContainerRemoved(
  containerName: string,
  kill: boolean,
  execute: (args: string[]) => Promise<DockerCommandResult> = executeDockerCommand,
  pause: () => Promise<void> = () => Bun.sleep(25),
  attempts = 40,
): Promise<void> {
  if (kill) await execute(['kill', containerName]);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const inspected = await execute(['inspect', containerName]);
    if (inspected.exitCode !== 0) {
      if (dockerReportsAbsent(inspected.stderr)) return;
      throw new Error(`sandbox container shutdown unconfirmed: ${containerName}: ${inspected.stderr.trim()}`);
    }
    await pause();
  }
  if (kill) {
    await execute(['rm', '-f', containerName]);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const inspected = await execute(['inspect', containerName]);
      if (inspected.exitCode !== 0) {
        if (dockerReportsAbsent(inspected.stderr)) return;
        throw new Error(`sandbox container shutdown unconfirmed: ${containerName}: ${inspected.stderr.trim()}`);
      }
      await pause();
    }
  }
  throw new Error(`sandbox container shutdown unconfirmed: ${containerName}`);
}

function dockerReportsAbsent(stderr: string): boolean {
  return /(?:no such container|no such object):/iu.test(stderr);
}

export async function readWorkspaceOutputs(
  root: string,
  paths: string[],
): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const outputs: Array<{ path: string; bytes: Uint8Array }> = [];
  let totalBytes = 0;
  for (const path of paths) {
    const handle = await open(
      workspacePath(root, path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error(`sandbox non-file output rejected: ${path}`);
      totalBytes += metadata.size;
      if (metadata.size > MAX_USER_FILE_BYTES || totalBytes > MAX_OUTPUT_TOTAL_BYTES) {
        throw new Error('sandbox output file limit exceeded');
      }
      const bytes = new Uint8Array(await handle.readFile());
      if (bytes.byteLength !== metadata.size) {
        throw new Error(`sandbox output changed while reading: ${path}`);
      }
      outputs.push({ path, bytes });
    } finally {
      await handle.close();
    }
  }
  return outputs;
}

async function executeDockerCommand(args: string[]): Promise<DockerCommandResult> {
  const process = Bun.spawn(['docker', ...args], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr };
}

async function regularWorkspaceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const pending = [''];
  let seenEntries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const absoluteDirectory = workspacePath(root, directory || '.');
    for (const entry of await readdir(absoluteDirectory)) {
      const path = directory ? `${directory}/${entry}` : entry;
      seenEntries += 1;
      if (seenEntries > 1_000) throw new Error('sandbox workspace entry count exceeded');
      const stat = await lstat(workspacePath(root, path));
      if (stat.isSymbolicLink()) throw new Error(`sandbox symlink output rejected: ${path}`);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile()) output.push(normalizeUserFilePath(path, entry));
      else throw new Error(`sandbox special file rejected: ${path}`);
      if (output.length > MAX_OUTPUT_FILES) throw new Error('sandbox output file count exceeded');
    }
  }
  return output.sort();
}

function workspacePath(root: string, relativePath: string): string {
  const normalized = normalizeUserFilePath(relativePath === '.' ? 'workspace' : relativePath, relativePath);
  const path = resolve(root, normalized === 'workspace' && relativePath === '.' ? '.' : normalized);
  const relation = relative(root, path);
  if (relation === '..' || relation.startsWith(`..${sep}`) || resolve(path) === resolve('/var/run/docker.sock')) {
    throw new Error('sandbox path escapes workspace');
  }
  return path;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  state: { used: number; exceeded: boolean },
  stop: () => void,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_OUTPUT_BYTES - state.used;
      if (remaining <= 0) {
        state.exceeded = true;
        stop();
        continue;
      }
      const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      chunks.push(chunk);
      state.used += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) {
        state.exceeded = true;
        stop();
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
