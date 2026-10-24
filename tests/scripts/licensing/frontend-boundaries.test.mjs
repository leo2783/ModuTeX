import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectFrontendBoundaries } from '../../../scripts/licensing/frontend-boundaries.mjs';

const portable = value => value.split(path.sep).join('/');

test('CSS scanner preserves escaped and quoted URLs while ignoring comments and strings', async () => {
  const root = await createBaseTree();
  try {
    await writeFile(path.join(root, 'apps/frontend/src/ab.png'), TINY_PNG_BUFFER);
    await writeFile(path.join(root, 'apps/frontend/src/styles.css'), [
      '/* url(missing-comment.png) */',
      '.a { content: "url(missing-string.png)"; background: url(\\61 b.png); }',
      '.b { background: URL("ab.png"); }',
      '.c { background: url( ab.png ); }'
    ].join('\n'));
    const result = await inspectFrontendBoundaries(root);
    const references = result.references.filter(item => item.path.endsWith('styles.css'));
    assert.deepEqual(references.map(item => item.specifier), ['ab.png', 'ab.png', 'ab.png']);
    assert.deepEqual(result.findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 1x1 transparent PNG binary bytes
const TINY_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

async function createBaseTree() {
  const root = await mkdtemp(path.join(tmpdir(), 'boundary-test-'));
  await mkdir(path.join(root, 'apps/frontend/src'), { recursive: true });
  await mkdir(path.join(root, 'packages/document-core/src'), { recursive: true });
  await mkdir(path.join(root, 'packages/frontend-contracts/src'), { recursive: true });
  await mkdir(path.join(root, 'docs/licensing'), { recursive: true });

  const defaultTsConfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      baseUrl: '.',
      paths: {
        '@doc/*': ['../../packages/frontend-contracts/src/*'],
        '@contract/*': ['../../packages/frontend-contracts/src/*']
      }
    }
  };
  await writeFile(
    path.join(root, 'apps/frontend/tsconfig.json'),
    JSON.stringify(defaultTsConfig, null, 2),
    'utf8'
  );

  const defaultManifest = {
    bundledDocuments: {
      files: []
    },
    generated: []
  };
  await writeFile(
    path.join(root, 'docs/licensing/frontend-origin.json'),
    JSON.stringify(defaultManifest, null, 2),
    'utf8'
  );

  await writeFile(
    path.join(root, 'apps/frontend/vite.config.ts'),
    'export default { plugins: [] };\n',
    'utf8'
  );

  return root;
}

test('frontend boundary inspector: accepted local TS, Svelte, and template dynamic imports produce zero findings', async () => {
  const root = await createBaseTree();
  try {
    // Local modules across the 3 approved source roots
    await writeFile(
      path.join(root, 'packages/frontend-contracts/src/model.ts'),
      'export interface Doc { id: string; }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'packages/frontend-contracts/src/api.ts'),
      'export const version = "1.0.0";\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'apps/frontend/src/utils.ts'),
      'export function helper() { return true; }\n',
      'utf8'
    );

    // TypeScript using relative import, alias import, and dynamic import
    await writeFile(
      path.join(root, 'apps/frontend/src/main.ts'),
      `import { helper } from './utils';
import type { Doc } from '@contract/model';
import { version } from '@contract/api';
export async function run() {
  const mod = await import('./utils');
  return { helper, version, mod };
}
`,
      'utf8'
    );

    // Svelte component with script import, CSS url/import, and {#await} template dynamic import
    await writeFile(
      path.join(root, 'apps/frontend/src/Component.svelte'),
      `<script lang="ts">
  import { helper } from './utils';
  const promise = import('./utils');
</script>

{#await import('./utils')}
  <p>Loading...</p>
{:then res}
  <p>Ready</p>
{/await}

<style>
  @import './theme.css';
  .box {
    background: url('./bg.png');
  }
</style>
`,
      'utf8'
    );

    await writeFile(
      path.join(root, 'apps/frontend/src/theme.css'),
      '.theme { color: red; }\n',
      'utf8'
    );
    // Real tiny PNG bytes fixture
    await writeFile(
      path.join(root, 'apps/frontend/src/bg.png'),
      TINY_PNG_BUFFER
    );

    const result = await inspectFrontendBoundaries(root);
    assert.equal(result.verdict, 'static-boundary-evidence-only');
    assert.deepEqual(result.findings, [], `Expected 0 findings, got: ${JSON.stringify(result.findings, null, 2)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: finds reference-outside-new-frontend for legacy imports and re-exports', async () => {
  const root = await createBaseTree();
  try {
    await mkdir(path.join(root, 'legacy/src'), { recursive: true });
    await writeFile(
      path.join(root, 'legacy/src/old.ts'),
      'export const oldVal = 42;\nexport const oldHelper = () => "legacy";\n',
      'utf8'
    );

    // Legacy import
    await writeFile(
      path.join(root, 'apps/frontend/src/bad-legacy.ts'),
      `import { oldVal } from '../../../legacy/src/old';\nexport { oldVal };\n`,
      'utf8'
    );

    // Legacy re-export (export ... from)
    await writeFile(
      path.join(root, 'apps/frontend/src/reexport-legacy.ts'),
      `export { oldHelper } from '../../../legacy/src/old';\n`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const legacyFindings = result.findings.filter(f => f.kind === 'reference-outside-new-frontend');
    assert.equal(legacyFindings.length, 2);
    assert.ok(legacyFindings.some(f => f.path === 'apps/frontend/src/bad-legacy.ts' && f.detail === 'legacy/src/old.ts'));
    assert.ok(legacyFindings.some(f => f.path === 'apps/frontend/src/reexport-legacy.ts' && f.detail === 'legacy/src/old.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: detects negative Svelte template dynamic import into legacy and re-export into legacy', async () => {
  const root = await createBaseTree();
  try {
    await mkdir(path.join(root, 'legacy/src'), { recursive: true });
    await writeFile(
      path.join(root, 'legacy/src/legacy-module.ts'),
      'export const legacyData = "forbidden";\n',
      'utf8'
    );

    // Svelte template {#await import(...)} dynamically targeting forbidden legacy
    await writeFile(
      path.join(root, 'apps/frontend/src/NegativeAwait.svelte'),
      `<script lang="ts">
  export { legacyData } from '../../../legacy/src/legacy-module';
</script>

{#await import('../../../legacy/src/legacy-module')}
  <p>Loading legacy...</p>
{:then mod}
  <p>{mod.legacyData}</p>
{/await}
`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const legacyFindings = result.findings.filter(
      f => f.path === 'apps/frontend/src/NegativeAwait.svelte' && f.kind === 'reference-outside-new-frontend'
    );
    // Should flag both: script re-export and template {#await import(...)}
    assert.equal(legacyFindings.length, 2);
    assert.ok(legacyFindings.every(f => f.detail === 'legacy/src/legacy-module.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: detects legacy reference via tsconfig paths alias', async () => {
  const root = await createBaseTree();
  try {
    await mkdir(path.join(root, 'legacy/src'), { recursive: true });
    await writeFile(
      path.join(root, 'legacy/src/compat.ts'),
      'export const compat = true;\n',
      'utf8'
    );

    const tsConfigWithLegacyAlias = {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        baseUrl: '.',
        paths: {
          '@legacy/*': ['../../legacy/src/*']
        }
      }
    };
    await writeFile(
      path.join(root, 'apps/frontend/tsconfig.json'),
      JSON.stringify(tsConfigWithLegacyAlias, null, 2),
      'utf8'
    );

    await writeFile(
      path.join(root, 'apps/frontend/src/alias-test.ts'),
      `import { compat } from '@legacy/compat';\nexport { compat };\n`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const finding = result.findings.find(f => f.kind === 'reference-outside-new-frontend');
    assert.ok(finding, 'Must flag reference-outside-new-frontend for legacy alias');
    assert.equal(finding.path, 'apps/frontend/src/alias-test.ts');
    assert.equal(finding.detail, 'legacy/src/compat.ts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: detects legacy type-only import as reference-outside-new-frontend', async () => {
  const root = await createBaseTree();
  try {
    await mkdir(path.join(root, 'legacy/src'), { recursive: true });
    await writeFile(
      path.join(root, 'legacy/src/types.ts'),
      'export interface LegacyType { x: number; }\n',
      'utf8'
    );

    await writeFile(
      path.join(root, 'apps/frontend/src/type-ref.ts'),
      `export type Foo = import('../../../legacy/src/types').LegacyType;\n`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const finding = result.findings.find(f => f.kind === 'reference-outside-new-frontend');
    assert.ok(finding, 'Must flag reference-outside-new-frontend for legacy type import');
    assert.equal(finding.path, 'apps/frontend/src/type-ref.ts');
    assert.equal(finding.detail, 'legacy/src/types.ts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: detects computed module references in TS and Svelte', async () => {
  const root = await createBaseTree();
  try {
    await writeFile(
      path.join(root, 'apps/frontend/src/dynamic-computed.ts'),
      `const modName = './utils';\nexport const loader = import(modName);\n`,
      'utf8'
    );
    await writeFile(
      path.join(root, 'apps/frontend/src/svelte-computed.svelte'),
      `<script>
  const name = './utils';
  const p = import(name);
</script>
`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const computedFindings = result.findings.filter(f => f.kind === 'computed-module-reference');
    assert.equal(computedFindings.length, 2);
    assert.ok(computedFindings.some(f => f.path === 'apps/frontend/src/dynamic-computed.ts' && f.detail === 'dynamic-import'));
    assert.ok(computedFindings.some(f => f.path === 'apps/frontend/src/svelte-computed.svelte' && f.detail === 'dynamic-import'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: handles raw license declared data vs unlisted or non-raw import', async () => {
  const root = await createBaseTree();
  try {
    await mkdir(path.join(root, 'docs/licenses'), { recursive: true });
    await writeFile(
      path.join(root, 'docs/licenses/MIT.txt'),
      'MIT License Text\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'docs/licenses/UNLISTED.txt'),
      'Other License Text\n',
      'utf8'
    );

    const manifest = {
      bundledDocuments: {
        files: ['docs/licenses/MIT.txt']
      },
      generated: []
    };
    await writeFile(
      path.join(root, 'docs/licensing/frontend-origin.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    // Valid: declared in manifest and imported with ?raw
    await writeFile(
      path.join(root, 'apps/frontend/src/valid-raw.ts'),
      `import mitLicense from '../../../docs/licenses/MIT.txt?raw';\nexport default mitLicense;\n`,
      'utf8'
    );

    // Invalid: imported without ?raw
    await writeFile(
      path.join(root, 'apps/frontend/src/invalid-non-raw.ts'),
      `import mitLicense from '../../../docs/licenses/MIT.txt';\nexport default mitLicense;\n`,
      'utf8'
    );

    // Invalid: unlisted document even if using ?raw
    await writeFile(
      path.join(root, 'apps/frontend/src/invalid-unlisted.ts'),
      `import unlisted from '../../../docs/licenses/UNLISTED.txt?raw';\nexport default unlisted;\n`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const outsideFindings = result.findings.filter(f => f.kind === 'reference-outside-new-frontend');
    assert.equal(outsideFindings.length, 2);
    assert.ok(outsideFindings.some(f => f.path === 'apps/frontend/src/invalid-non-raw.ts' && f.detail === 'docs/licenses/MIT.txt'));
    assert.ok(outsideFindings.some(f => f.path === 'apps/frontend/src/invalid-unlisted.ts' && f.detail === 'docs/licenses/UNLISTED.txt'));
    assert.ok(!outsideFindings.some(f => f.path === 'apps/frontend/src/valid-raw.ts'), 'valid ?raw import must not have findings');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: detects source symlinks using actual filesystem symlink or directory junction', async () => {
  const root = await createBaseTree();
  try {
    const targetDir = path.join(root, 'apps/frontend/src/sub');
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      path.join(targetDir, 'target.ts'),
      'export const x = 1;\n',
      'utf8'
    );

    const linkPath = path.join(root, 'apps/frontend/src/link-entry');
    // On Windows, directory junctions do not require administrator or developer mode privileges.
    // Try file symlink first, if EPERM or failure occurs, fallback to junction directory link.
    try {
      await symlink('sub/target.ts', linkPath, 'file');
    } catch {
      await symlink(targetDir, linkPath, 'junction');
    }

    const result = await inspectFrontendBoundaries(root);
    const linkFinding = result.findings.find(f => f.kind === 'source-symlink');
    assert.ok(linkFinding, 'Must detect source-symlink without silent skip');
    assert.equal(linkFinding.path, 'apps/frontend/src/link-entry');
    assert.equal(linkFinding.detail, 'Source links require explicit review');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: detects malformed Svelte with source-parse-error', async () => {
  const root = await createBaseTree();
  try {
    await writeFile(
      path.join(root, 'apps/frontend/src/broken.svelte'),
      `<script>\n  let a = \n</script>\n<div unclosed>`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const parseError = result.findings.find(f => f.kind === 'source-parse-error');
    assert.ok(parseError, 'Must detect source-parse-error for malformed Svelte file');
    assert.equal(parseError.path, 'apps/frontend/src/broken.svelte');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: flags vite-alias-review-required when alias is defined in vite.config.ts', async () => {
  const root = await createBaseTree();
  try {
    await writeFile(
      path.join(root, 'apps/frontend/vite.config.ts'),
      `import { defineConfig } from 'vite';
export default defineConfig({
  resolve: {
    alias: {
      '@custom': '/some/custom/path'
    }
  }
});
`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const aliasFinding = result.findings.find(f => f.kind === 'vite-alias-review-required');
    assert.ok(aliasFinding, 'Must flag vite-alias-review-required');
    assert.equal(aliasFinding.path, 'apps/frontend/vite.config.ts');
    assert.equal(aliasFinding.detail, 'Resolve plugin/config aliases independently before clearance');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: detects unresolved and external module references', async () => {
  const root = await createBaseTree();
  try {
    await writeFile(
      path.join(root, 'apps/frontend/src/ext.ts'),
      `import 'https://example.com/cdn.js';
import '/absolute/root/import.js';
import 'completely-non-existent-pkg-xyz-987';
`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const extFindings = result.findings.filter(f => f.kind === 'external-module-reference');
    const unresFindings = result.findings.filter(f => f.kind === 'unresolved-module-reference');

    assert.equal(extFindings.length, 2);
    assert.ok(extFindings.some(f => f.detail === 'https://example.com/cdn.js'));
    assert.ok(extFindings.some(f => f.detail === '/absolute/root/import.js'));

    assert.equal(unresFindings.length, 1);
    assert.equal(unresFindings[0].detail, 'completely-non-existent-pkg-xyz-987');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: flags unresolved-glob-expansion for Vite import.meta.glob in TS and Svelte', async () => {
  const root = await createBaseTree();
  try {
    await writeFile(
      path.join(root, 'apps/frontend/src/utils.ts'),
      'export const answer = 42;\n',
      'utf8'
    );

    await writeFile(
      path.join(root, 'apps/frontend/src/glob-caller.ts'),
      `import { answer } from './utils';
export const modules = import.meta.glob('./features/*.ts');
export { answer };
`,
      'utf8'
    );

    await writeFile(
      path.join(root, 'apps/frontend/src/GlobComponent.svelte'),
      `<script lang="ts">
  import { answer } from './utils';
  const svelteModules = import.meta.glob('./components/*.svelte');
</script>

<p>Status: {answer}</p>
{#each Object.keys(import.meta.glob('./sub/*.ts')) as path}
  <span>{path}</span>
{/each}
`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const globFindings = result.findings.filter(f => f.kind === 'unresolved-glob-expansion');

    assert.equal(globFindings.length, 3, 'Must flag all genuine import.meta.glob invocations');
    assert.ok(globFindings.some(f => f.path === 'apps/frontend/src/glob-caller.ts' && f.detail === './features/*.ts'));
    assert.ok(globFindings.some(f => f.path === 'apps/frontend/src/GlobComponent.svelte' && f.detail === './components/*.svelte'));
    assert.ok(globFindings.some(f => f.path === 'apps/frontend/src/GlobComponent.svelte' && f.detail === './sub/*.ts'));

    // Regular imports must remain recorded in references without false errors
    assert.ok(result.references.some(r => r.path === 'apps/frontend/src/glob-caller.ts' && r.specifier === './utils'));
    assert.ok(result.references.some(r => r.path === 'apps/frontend/src/GlobComponent.svelte' && r.specifier === './utils'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: ignores comments, strings, and property lookalikes for import.meta.glob', async () => {
  const root = await createBaseTree();
  try {
    await writeFile(
      path.join(root, 'apps/frontend/src/utils.ts'),
      'export const answer = 42;\n',
      'utf8'
    );

    await writeFile(
      path.join(root, 'apps/frontend/src/negative-controls.ts'),
      `import { answer } from './utils';
// Single line comment: import.meta.glob('./forbidden/*.ts')
/* Multi line comment:
   import.meta.glob('./legacy/*.ts')
*/
const dummyString = "import.meta.glob('./fake/*.ts')";
const fakeObject = {
  'import.meta.glob': true,
  glob: (p: string) => p
};
fakeObject.glob('./fake/*.ts');
const customMeta = {
  import: {
    meta: {
      glob: (p: string) => p
    }
  }
};
customMeta.import.meta.glob('./nested/*.ts');
const currentAssetUrl = import.meta.url;
export { answer, dummyString, currentAssetUrl };
`,
      'utf8'
    );

    await writeFile(
      path.join(root, 'apps/frontend/src/NegativeComponent.svelte'),
      `<script lang="ts">
  import { answer } from './utils';
  // import.meta.glob('./script-comment/*.ts')
  const str = 'import.meta.glob("./fake/*.svelte")';
  const metaUrl = import.meta.url;
</script>

<!-- HTML comment: import.meta.glob('./template-comment/*.svelte') -->
<div>{str} - {answer} - {metaUrl}</div>
`,
      'utf8'
    );

    const result = await inspectFrontendBoundaries(root);
    const globFindings = result.findings.filter(f => f.kind === 'unresolved-glob-expansion');

    assert.equal(globFindings.length, 0, 'Negative controls must produce zero unresolved-glob-expansion findings');
    assert.deepEqual(result.findings, [], `Expected 0 total findings for valid local files, got: ${JSON.stringify(result.findings)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector treats only statically import.meta-rooted URLs as build assets and ignores runtime URLs', async () => {
  const root = await createBaseTree();
  try {
    await writeFile(path.join(root, 'apps/frontend/src/worker.js'), 'export default 1;\n', 'utf8');
    await writeFile(path.join(root, 'apps/frontend/src/urls.ts'), `
const runtimePath = '/workspace/file.tex';
new URL(runtimePath);
new URL('./worker.js', window.location.href);
new URL('./worker.js', import.meta.url);
`, 'utf8');
    await writeFile(path.join(root, 'apps/frontend/src/Urls.svelte'), `
<script>
  const runtimePath = '/workspace/file.tex';
  new URL(runtimePath);
  new URL('./worker.js', location.href);
  new URL('./worker.js', import.meta.url);
</script>
`, 'utf8');

    const result = await inspectFrontendBoundaries(root);
    const assets = result.references.filter(item => item.kind === 'asset-url');
    assert.deepEqual(assets.map(item => item.specifier), ['./worker.js', './worker.js']);
    assert.deepEqual(result.findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: rejects dynamic new URL with import.meta.url as computed module reference', async () => {
  const root = await createBaseTree();
  try {
    await writeFile(path.join(root, 'apps/frontend/src/dynamic-url.ts'), `
const dynamicPath = './worker.js';
new URL(dynamicPath, import.meta.url);
`, 'utf8');
    await writeFile(path.join(root, 'apps/frontend/src/DynamicUrl.svelte'), `
<script>
  const dynamicPath = './worker.js';
  new URL(dynamicPath, import.meta.url);
</script>
`, 'utf8');

    const result = await inspectFrontendBoundaries(root);
    const dynamicFindings = result.findings.filter(item => item.kind === 'computed-module-reference');
    assert.equal(dynamicFindings.length, 2);
    assert.ok(dynamicFindings.some(item => item.path === 'apps/frontend/src/dynamic-url.ts' && item.detail === 'asset-url'));
    assert.ok(dynamicFindings.some(item => item.path === 'apps/frontend/src/DynamicUrl.svelte' && item.detail === 'asset-url'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend boundary inspector: rejects forbidden paths in new URL with import.meta.url', async () => {
  const root = await createBaseTree();
  try {
    await mkdir(path.join(root, 'legacy/src'), { recursive: true });
    await writeFile(path.join(root, 'legacy/src/forbidden.js'), 'export const forbidden = true;\n', 'utf8');
    await writeFile(path.join(root, 'apps/frontend/src/forbidden-url.ts'), `
new URL('../../../legacy/src/forbidden.js', import.meta.url);
`, 'utf8');
    await writeFile(path.join(root, 'apps/frontend/src/ForbiddenUrl.svelte'), `
<script>
  new URL('../../../legacy/src/forbidden.js', import.meta.url);
</script>
`, 'utf8');

    const result = await inspectFrontendBoundaries(root);
    const outsideFindings = result.findings.filter(item => item.kind === 'reference-outside-new-frontend');
    assert.equal(outsideFindings.length, 2);
    assert.ok(outsideFindings.some(item => item.path === 'apps/frontend/src/forbidden-url.ts' && item.detail === 'legacy/src/forbidden.js'));
    assert.ok(outsideFindings.some(item => item.path === 'apps/frontend/src/ForbiddenUrl.svelte' && item.detail === 'legacy/src/forbidden.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
