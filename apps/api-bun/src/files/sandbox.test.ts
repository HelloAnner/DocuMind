import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDockerArgs,
  ensureDockerContainerRemoved,
  readWorkspaceOutputs,
} from './sandbox.ts';

describe('bash sandbox', () => {
  test('Docker arguments enforce confinement and expose only the workspace', () => {
    const args = buildDockerArgs(
      'documind-bash-runner:test', '/tmp/documind-workspace', 'python tool.py', 'documind-test',
    );
    for (const value of [
      '--rm', '--network', 'none', '--user', '65532:65532', '--read-only',
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--cpus', '1',
      '--memory', '512m', '--pids-limit', '64', '--workdir', '/workspace',
    ]) expect(args).toContain(value);
    expect(args.filter((value) => value.startsWith('type=bind,'))).toEqual([
      'type=bind,src=/tmp/documind-workspace,dst=/workspace',
    ]);
    expect(args.join(' ')).not.toContain('/var/run/docker.sock');
    expect(args.slice(-7)).toEqual([
      '--entrypoint', '/bin/bash', 'documind-bash-runner:test',
      '--noprofile', '--norc', '-c', 'python tool.py',
    ]);
  });

  test('sync requires inspect to authoritatively report container absence', async () => {
    const calls: string[] = [];
    let releaseKill!: () => void;
    const killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const pending = ensureDockerContainerRemoved('container', true, async (args) => {
      calls.push(args[0]!);
      if (args[0] === 'kill') {
        await killGate;
        return { exitCode: 1, stderr: 'daemon kill failed' };
      }
      return { exitCode: 1, stderr: 'Error: No such object: container' };
    });
    await Promise.resolve();
    expect(calls).toEqual(['kill']);
    releaseKill();
    await pending;
    expect(calls).toEqual(['kill', 'inspect']);

    for (const stderr of [
      'permission denied while trying to connect to the Docker daemon socket',
      'Cannot connect to the Docker daemon',
      'transport is closing',
    ]) {
      await expect(ensureDockerContainerRemoved(
        'container', false,
        async () => ({ exitCode: 1, stderr }),
        async () => {}, 1,
      )).rejects.toThrow('shutdown unconfirmed');
    }

    await expect(ensureDockerContainerRemoved(
      'container', true,
      async (args) => args[0] === 'kill'
        ? { exitCode: 1, stderr: 'kill failed' }
        : { exitCode: 1, stderr: 'Error response from daemon: No such container: container' },
      async () => {}, 1,
    )).resolves.toBeUndefined();
  });

  test('opens output through O_NOFOLLOW and rejects symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'documind-nofollow-'));
    try {
      await writeFile(join(root, 'target.txt'), 'secret');
      await symlink('target.txt', join(root, 'output.txt'));
      await expect(readWorkspaceOutputs(root, ['output.txt'])).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
