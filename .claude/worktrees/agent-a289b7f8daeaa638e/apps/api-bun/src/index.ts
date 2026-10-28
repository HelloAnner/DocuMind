// DocuMind TS 后端入口（移植自 apps/api-rs/src/main.rs）
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { runBashRunnerAcceptance } from './files/sandbox.ts';

async function main(): Promise<void> {
  const runnerAcceptanceIndex = process.argv.indexOf('--runner-acceptance');
  if (runnerAcceptanceIndex >= 0) {
    const image = process.argv[runnerAcceptanceIndex + 1];
    if (!image) throw new Error('--runner-acceptance requires an image tag');
    await runBashRunnerAcceptance(image);
    console.log('runner-acceptance-ok');
    return;
  }
  // dotenv 等价：Bun 自动读取 .env；显式兜底
  const config = loadConfig();
  const { app } = await createApp(config);
  const port = config.serverPort;
  const host = config.serverHost;
  const server = Bun.serve({
    port, hostname: host,
    idleTimeout: 255,
    fetch: app.fetch,
  });
  console.log(`[documind] runtime listening on http://${host}:${port} (bun ${Bun.version})`);
  process.on('SIGTERM', () => { console.log('[documind] SIGTERM received, shutting down'); server.stop(); process.exit(0); });
  process.on('SIGINT', () => { server.stop(); process.exit(0); });
}

main().catch((error) => {
  console.error('[documind] fatal:', error);
  process.exit(1);
});
