// 生成 src/generated/web_assets.ts：把 apps/web/out 内嵌进 bun --compile 产物
// 用法: bun run scripts/gen-web-assets.ts [webOutDir]
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const webOut = process.argv[2] ?? join(root, 'apps', 'web', 'out');
const outFile = join(import.meta.dir, '..', 'src', 'generated', 'web_assets.ts');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (stat.isFile()) yield path;
  }
}

const files = [...walk(webOut)].sort();
mkdirSync(dirname(outFile), { recursive: true });


let body = '// 自动生成，勿手改。来源: scripts/gen-web-assets.ts\n';
body += 'const loaders: Record<string, () => Uint8Array> = {};\n';
files.forEach((file) => {
  const webPath = relative(webOut, file).split('\\').join('/');
  const base64 = readFileSync(file).toString('base64');
  body += `loaders[${JSON.stringify(webPath)}] = () => Buffer.from(${JSON.stringify(base64)}, 'base64');\n`;
});
body += 'export default loaders;\n';
writeFileSync(outFile, body);
console.log(`generated ${files.length} web assets -> ${relative(root, outFile)}`);
