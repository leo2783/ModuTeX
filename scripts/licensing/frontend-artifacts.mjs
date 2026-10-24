import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const portable = value => value.split(path.sep).join('/');

// Evidence collector, not a license decision or a replacement for build-graph review.
export async function inventoryFrontend(rootDirectory, distDirectory = 'apps/frontend/dist-tauri') {
  const root = await realpath(rootDirectory);
  const dist = await realpath(path.resolve(root, distDirectory));
  if (!inside(root, dist)) throw new Error('DIST_OUTSIDE_REPOSITORY');
  const relative = value => portable(path.relative(root, value));
  const files = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`SYMLINK_ARTIFACT: ${relative(absolute)}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await walk(dist);
  const packages = new Map();
  const sources = new Map();
  const artifacts = [];
  const unresolved = [];
  // Vite maps its generated ?url module, not the resource bytes. Trace both.
  async function resourceTrace(mapFile, embedded, sourceBytes) {
    if (typeof embedded !== 'string' || !/^export default ["']__VITE_ASSET__[A-Za-z\d_$]+__["'];?\s*$/.test(embedded)) return null;
    const scriptFile = mapFile.slice(0, -4);
    if (!files.includes(scriptFile)) return null;
    const script = ts.createSourceFile(scriptFile, (await readFile(scriptFile)).toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (script.parseDiagnostics.length) return null;
    const urls = new Set();
    function visit(node) {
      if (ts.isStringLiteralLike(node)) urls.add(node.text);
      ts.forEachChild(node, visit);
    }
    visit(script);
    const resourceHash = digest(sourceBytes);
    const matched = new Set();
    for (const url of urls) {
      if (!url || /[?#\\]/.test(url) || /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//')) continue;
      const emitted = url.startsWith('/') ? path.resolve(dist, `.${url}`) : path.resolve(path.dirname(scriptFile), url);
      if (!inside(dist, emitted) || !files.includes(emitted)) continue;
      if (digest(await readFile(emitted)) === resourceHash) matched.add(relative(emitted));
    }
    if (matched.size !== 1) return null;
    return { kind: 'vite-url-module', wrapperSha256: digest(Buffer.from(embedded)), resourceSha256: resourceHash,
      emitted: [...matched][0], script: relative(scriptFile) };
  }
  // Reads a regular file only if its real path stays inside root (symlinks cannot escape).
  async function readContained(file) {
    const actual = await realpath(file);
    if (!inside(root, actual)) throw new Error(`PACKAGE_FILE_OUTSIDE_REPOSITORY: ${relative(file)}`);
    if (!(await stat(actual)).isFile()) throw new Error(`PACKAGE_FILE_NOT_FILE: ${relative(file)}`);
    return readFile(actual);
  }
  async function packageFor(source) {
    let directory = path.dirname(source);
    while (inside(root, directory)) {
      const manifestPath = path.join(directory, 'package.json');
      let bytes;
      try { bytes = await readContained(manifestPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (bytes) {
        const manifest = JSON.parse(bytes);
        const key = relative(directory);
        if (!packages.has(key)) {
          const documents = [];
          for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!(entry.isFile() || entry.isSymbolicLink()) || !/^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)) continue;
            const documentPath = path.join(directory, entry.name);
            const content = await readContained(documentPath);
            documents.push({ path: relative(documentPath), sha256: digest(content), text: content.toString('utf8') });
          }
          packages.set(key, { path: key, name: manifest.name ?? null, version: manifest.version ?? null,
            declaredLicense: manifest.license ?? null, manifestSha256: digest(bytes), documents,
            reviewStatus: 'pending-independent-review' });
          if (documents.length === 0) unresolved.push({ kind: 'missing-license-documents', path: key });
        }
        return key;
      }
      if (directory === root) break;
      directory = path.dirname(directory);
    }
    return null;
  }
  for (const filename of files) {
    const bytes = await readFile(filename);
    artifacts.push({ path: relative(filename), bytes: bytes.length, sha256: digest(bytes) });
    if (!filename.endsWith('.map')) continue;
    const map = JSON.parse(bytes);
    if (map.version !== 3 || !Array.isArray(map.sources) || (map.sourceRoot && typeof map.sourceRoot !== 'string')) {
      throw new Error(`UNSUPPORTED_SOURCE_MAP: ${relative(filename)}`);
    }
    for (let index = 0; index < map.sources.length; index++) {
      const name = map.sources[index];
      if (typeof name !== 'string' || /^[a-z][a-z\d+.-]*:/i.test(name) || /^[a-z][a-z\d+.-]*:/i.test(map.sourceRoot ?? '')) {
        unresolved.push({ kind: 'non-file-map-source', map: relative(filename), source: name });
        continue;
      }
      const queryIndex = name.indexOf('?');
      const query = queryIndex === -1 ? [] : name.slice(queryIndex + 1).split('&');
      const urlModule = query.includes('url');
      const rawModule = query.includes('raw');
      const sourceName = urlModule || rawModule ? name.slice(0, queryIndex) : name;
      const candidate = path.resolve(path.dirname(filename), map.sourceRoot ?? '', sourceName);
      if (!inside(root, candidate)) throw new Error(`SOURCE_OUTSIDE_REPOSITORY: ${name}`);
      let absolute;
      try { absolute = await realpath(candidate); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        unresolved.push({ kind: 'missing-map-source', map: relative(filename), source: relative(candidate) });
        continue;
      }
      if (!inside(root, absolute)) throw new Error(`SOURCE_SYMLINK_OUTSIDE_REPOSITORY: ${name}`);
      if (!(await stat(absolute)).isFile()) throw new Error(`SOURCE_NOT_FILE: ${name}`);
      const sourceBytes = await readFile(absolute);
      const embedded = map.sourcesContent?.[index];
      const trace = urlModule ? await resourceTrace(filename, embedded, sourceBytes) : null;
      const matches = !urlModule && typeof embedded === 'string' && embedded === sourceBytes.toString('utf8');
      if (urlModule && !trace) unresolved.push({ kind: 'url-resource-unverified', map: relative(filename), source: relative(absolute) });
      else if (!urlModule && !matches) unresolved.push({ kind: 'source-content-unverified', map: relative(filename), source: relative(absolute) });
      const key = relative(absolute);
      let source = sources.get(key);
      if (!source) {
        source = {
          path: key,
          sha256: digest(sourceBytes),
          package: rawModule ? null : await packageFor(absolute),
          maps: [],
          rawDocumentEvidence: []
        };
        sources.set(key, source);
      }
      source.maps.push(relative(filename));
      if (rawModule && matches) {
        const emittedPath = filename.slice(0, -4);
        const emitted = artifacts.find(item => item.path === relative(emittedPath));
        if (emitted) {
          source.rawDocumentEvidence.push({
            map: relative(filename),
            emittedPath: emitted.path,
            emittedSha256: emitted.sha256
          });
        }
      }
      if (trace) (source.generatedResources ??= []).push({ map: relative(filename), ...trace });
    }
  }


  const fileSet = new Set(files);
  for (const filename of files) {
    if (/\.(?:m?js|cjs)$/.test(filename) && !fileSet.has(`${filename}.map`)) {
      unresolved.push({ kind: 'script-without-source-map', path: relative(filename) });
    }
    if (/\.(?:css|woff2?|ttf|otf|svg|png|jpe?g|webp)$/.test(filename)) {
      unresolved.push({ kind: 'asset-origin-review-required', path: relative(filename) });
    }
  }
  return { schemaVersion: 1, scope: relative(dist), verdict: 'inventory-only-not-license-clearance',
    limitations: ['Source maps do not prove complete module coverage, provenance, or legal independence.',
      'Raw bundled documents and generated CSS/assets require separate review.',
      'Installed transitive dependencies omitted by tree shaking are not the shipped module closure.'],
    artifacts, sources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)),
    bundledDocuments: [],
    packages: [...packages.values()].sort((a, b) => a.path.localeCompare(b.path)),
    unresolved,
    resolved: [] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await inventoryFrontend(process.cwd());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
