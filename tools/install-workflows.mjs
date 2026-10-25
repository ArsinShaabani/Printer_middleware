/**
 * Copy the canonical CI workflows from ci/github-workflows/ into
 * .github/workflows/ (they cannot be pushed by the automation token, which has
 * no `workflows` permission). Run: node tools/install-workflows.mjs
 */
import { readdir, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'ci/github-workflows');
const DEST = join(ROOT, '.github/workflows');

async function main() {
  const files = (await readdir(SRC)).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  if (!files.length) throw new Error(`no workflow files found in ${SRC}`);
  await mkdir(DEST, { recursive: true });
  for (const file of files) {
    const text = await readFile(join(SRC, file), 'utf8');
    await writeFile(join(DEST, file), text);
    console.log(`installed .github/workflows/${file}`);
  }
  try {
    await access(join(DEST, 'deploy-pages.yml'));
    console.log('\nNext steps:');
    console.log('  git add .github/workflows && git commit -m "ci: enable the workflows" && git push');
    console.log('  then enable Settings -> Pages -> Source: GitHub Actions');
  } catch (e) {
    console.log('note: deploy-pages.yml missing from the source directory');
  }
}

main().catch((e) => {
  console.error('install-workflows failed:', e.message);
  process.exit(1);
});
