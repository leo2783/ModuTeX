import { appendFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';

// Hosted Windows TEMP may be a junction. Keep production alias rejection intact;
// create test fixtures beneath the canonical directory in subsequent CI steps.
if (process.platform !== 'win32') throw new Error('This setup is for Windows CI only');
const environmentFile = process.env.GITHUB_ENV;
if (!environmentFile || !isAbsolute(environmentFile)) throw new Error('GitHub environment file is required');
// The native implementation also expands DOS 8.3 aliases (e.g. RUNNER~1).
const canonicalTemp = await realpath(tmpdir());
appendFileSync(environmentFile, `TEMP=${canonicalTemp}\nTMP=${canonicalTemp}\n`, 'utf8');
console.log('Configured canonical Windows test TEMP');
