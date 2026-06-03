import { mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';

const rootDir = path.resolve(import.meta.dirname, '..');
const sourceDir = path.join(rootDir, 'public');
const outputDir = path.join(rootDir, 'dist', 'public');

async function buildFile(sourcePath, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });

  if (sourcePath.endsWith('.js')) {
    const source = await readFile(sourcePath, 'utf8');
    const result = await transform(source, {
      format: 'esm',
      legalComments: 'none',
      minify: true,
      sourcemap: false,
      target: 'es2022',
    });
    await writeFile(outputPath, result.code);
    return;
  }

  await copyFile(sourcePath, outputPath);
}

async function buildDirectory(sourceRoot, outputRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const outputPath = path.join(outputRoot, entry.name);
    if (entry.isDirectory()) {
      await buildDirectory(sourcePath, outputPath);
    } else if (entry.isFile()) {
      await buildFile(sourcePath, outputPath);
    }
  }
}

await rm(outputDir, { recursive: true, force: true });
await buildDirectory(sourceDir, outputDir);
