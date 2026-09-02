import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

try {
  await access(resolve('public/vendor/maic-importer/index.js'));
} catch {
  throw new Error('MAIC importer vendor output is missing. Run the workspace postinstall step first.');
}
