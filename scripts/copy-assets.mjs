import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * tsc copies .ts and nothing else, so migrations and templates would be absent
 * from the built image — and the failure surfaces as "0 migrations pending" on
 * a fresh production database, which is the worst possible way to find out.
 */
const ASSET_EXTENSIONS = ['.sql', '.hbs', '.css'];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (ASSET_EXTENSIONS.some((e) => path.endsWith(e))) out.push(path);
  }
  return out;
}

const files = walk('src');
for (const file of files) {
  // `dist/<src-relative path>`, keeping the `src/` prefix, because tsconfig's
  // rootDir is the project root and tsc emits `src/x.ts` -> `dist/src/x.js`.
  // Stripping `src/` here would put migrations at dist/platform/... while the
  // code that reads them lives at dist/src/platform/... — and the symptom is a
  // production migrate that reports "up to date" against an empty database.
  const destination = join('dist', file);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(file, destination);
}

console.log(`copied ${files.length} asset file(s) into dist/`);
