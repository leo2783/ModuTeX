import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFrontendBoundaries } from './frontend-boundaries.mjs';
import { inventoryFrontend } from './frontend-artifacts.mjs';
import { collectAssetProvenance } from './frontend-asset-origins.mjs';

export async function verifyFrontendOrigin(root) {
  const boundaries = await inspectFrontendBoundaries(root);
  const artifacts = await inventoryFrontend(root);
  const assets = await collectAssetProvenance(root);
  const blockers = [
    ...boundaries.findings,
    ...artifacts.unresolved,
    ...assets.unresolved,
    ...artifacts.packages.filter(item => /\bAGPL\b/i.test(item.declaredLicense ?? '')).map(item => ({ kind: 'agpl-bundled-package', path: item.path })),
    // The collector deliberately keeps every package review pending. An inventory
    // or byte match must never silently approve its provenance/license closure.
    ...artifacts.packages.filter(item => item.reviewStatus !== 'approved').map(item => ({ kind: 'independent-package-review-required', path: item.path }))
  ];
  return { schemaVersion: 1, verdict: 'not-cleared', blockers, boundaries, artifacts, assets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyFrontendOrigin(process.cwd());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Frontend origin verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
