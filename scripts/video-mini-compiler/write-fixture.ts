/** CLI for producing the fixed S3 two-page compiler fixture ZIP. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTwoPageCourse } from './compile.js';
import { twoPageSample } from './fixture.js';

export async function writeTwoPageFixtureZip(outputPath: string): Promise<void> {
  const absolutePath = resolve(outputPath);
  const zip = await compileTwoPageCourse(twoPageSample);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, zip);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';

if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputPath = process.argv[2];
  if (!outputPath) {
    console.error('Usage: tsx scripts/video-mini-compiler/write-fixture.ts <output.zip>');
    process.exitCode = 1;
  } else {
    writeTwoPageFixtureZip(outputPath).then(() => {
      console.log(`Wrote two-page video fixture: ${resolve(outputPath)}`);
    });
  }
}
