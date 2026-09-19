// DocuMind TS 后端入口（移植自 apps/api-rs/src/main.rs）
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';

async function main(): Promise<void> {
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
