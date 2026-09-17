// 生成 src/generated/web_assets.ts：把 apps/web/out 内嵌进 bun --compile 产物
// 用法: bun run scripts/gen-web-assets.ts [webOutDir]
import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

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

const relToGenerated = (absPath: string): string => {
  const rel = relative(join(import.meta.dir, '..', 'src', 'generated'), absPath);
  return rel.split('\').join('/');
};

let body = '// 自动生成，勿手改。来源: scripts/gen-web-assets.ts
';
body += 'const assets: Record<string, () => Uint8Array> = {
';
for (const file of files) {
  const webPath = relative(webOut, file).split('\').join('/');
  body += `  '${webPath}': () => new Uint8Array(require('${relToGenerated(file)}')),
`;
}
body += '};
export default assets;
';
writeFileSync(outFile, body);
console.log(`generated ${files.length} web assets -> ${relative(root, outFile)}`);
