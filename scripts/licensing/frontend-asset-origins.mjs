import { createHash } from 'node:crypto';
import { readFile as readFsFile, readdir as readFsDirectory, realpath, stat as statFsPath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const portable = value => value.split(path.sep).join('/');

// Canonical SHA-256 hash of official SIL OFL 1.1 text (normalized LF, trimmed).
// Project policy binding to documented SIL source; not independent legal clearance.
const CANONICAL_OFL_1_1_SHA256 = '6f9807a7127177a76fae2209e11f4b90d01a50cbfdb3dfe5704c2dcb2c68a3d1';

// Shipped asset provenance evidence collector, not a license clearance or clean-room verdict.
export async function collectAssetProvenance(rootDirectory, distDirectory = 'apps/frontend/dist') {
  if (typeof rootDirectory !== 'string' || rootDirectory.trim().length === 0) {
    throw new TypeError('rootDirectory must be a non-empty string');
  }
  if (typeof distDirectory !== 'string' || distDirectory.trim().length === 0) {
    throw new TypeError('distDirectory must be a non-empty string');
  }
  const root = await realpath(rootDirectory);
  async function checkedPath(candidate) {
    const resolved = await realpath(candidate);
    if (!inside(root, resolved)) throw new Error(`SOURCE_OUTSIDE_REPOSITORY: ${candidate}`);
    return resolved;
  }
  const readFile = async candidate => readFsFile(await checkedPath(candidate));
  const readdir = async (candidate, options) => readFsDirectory(await checkedPath(candidate), options);
  const stat = async candidate => statFsPath(await checkedPath(candidate));
  const distCandidate = path.resolve(root, distDirectory);
  if (!inside(root, distCandidate)) throw new Error('DIST_OUTSIDE_REPOSITORY');
  let dist;
  try {
    dist = await realpath(distCandidate);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`DIST_NOT_FOUND: ${distCandidate}`);
    throw error;
  }
  if (!inside(root, dist)) throw new Error('DIST_OUTSIDE_REPOSITORY');

  const relative = value => portable(path.relative(root, value));
  const distFiles = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = await realpath(absolute);
        } catch {}
        if (target && !inside(root, target)) {
          throw new Error(`SYMLINK_OUTSIDE_REPOSITORY: ${relative(absolute)}`);
        }
        throw new Error(`SYMLINK_ARTIFACT: ${relative(absolute)}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        distFiles.push(absolute);
      }
    }
  }
  await walk(dist);

  async function resolvePackage(packageName) {
    const candidates = [
      path.join(root, 'node_modules', packageName),
      path.join(root, 'apps', 'frontend', 'node_modules', packageName)
    ];
    for (const candidate of candidates) {
      const manifestPath = path.join(candidate, 'package.json');
      let bytes;
      try { bytes = await readFile(manifestPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (bytes) {
        try {
          const manifest = JSON.parse(bytes.toString('utf8'));
          return { dir: candidate, manifest };
        } catch {}
      }
    }
    return null;
  }

  const unresolved = [];

  // 1. Resolve installed packages
  const pdfjsPkg = await resolvePackage('pdfjs-dist');
  const mathlivePkg = await resolvePackage('mathlive');
  const prosemirrorPkg = await resolvePackage('prosemirror-view');

  // 2. Index installed PDF.js prebuilt worker
  let prebuiltWorker = null;
  if (pdfjsPkg) {
    const workerCandidate = path.join(pdfjsPkg.dir, 'build', 'pdf.worker.mjs');
    try {
      const bytes = await readFile(workerCandidate);
      prebuiltWorker = {
        path: workerCandidate,
        bytes: bytes.length,
        sha256: digest(bytes),
        content: bytes.toString('utf8')
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      unresolved.push({ kind: 'missing-installed-pdf-worker-source', path: relative(workerCandidate) });
    }
  } else {
    unresolved.push({ kind: 'missing-installed-package', package: 'pdfjs-dist' });
  }

  // 3. Index installed MathLive fonts and inspect font license document
  const installedFontsBySha = new Map();
  const installedFontsByName = new Map();
  const installedFontsByPath = new Map();
  let fontLicenseDocumentPresent = false;
  let fontLicenseDocumentName = null;
  let fontLicenseDocumentPath = null;
  let installedOflBytes = null;

  if (mathlivePkg) {
    const fontDir = path.join(mathlivePkg.dir, 'fonts');
    try {
      const fontEntries = await readdir(fontDir, { withFileTypes: true });
      for (const entry of fontEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && entry.name.endsWith('.woff2')) {
          const fullPath = path.join(fontDir, entry.name);
          const bytes = await readFile(fullPath);
          const sha256 = digest(bytes);
          const record = {
            filename: entry.name,
            bytes: bytes.length,
            sha256,
            path: relative(fullPath)
          };
          installedFontsBySha.set(sha256, record);
          installedFontsByName.set(entry.name, record);
          installedFontsByPath.set(record.path, record);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      unresolved.push({ kind: 'missing-installed-mathlive-fonts-dir', path: relative(fontDir) });
    }

    try {
      const pkgEntries = await readdir(mathlivePkg.dir, { withFileTypes: true });
      for (const entry of pkgEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && /^(?:ofl|sil|fontlog|fonts?-license|license-fonts?)(?:[._-].*)?$/i.test(entry.name)) {
          const candidatePath = path.join(mathlivePkg.dir, entry.name);
          await checkedPath(candidatePath);
          fontLicenseDocumentPresent = true;
          fontLicenseDocumentName = entry.name;
          fontLicenseDocumentPath = candidatePath;
          break;
        }
      }
    } catch (error) {
      if (error.message?.includes('SOURCE_OUTSIDE_REPOSITORY')) throw error;
    }

    if (!fontLicenseDocumentPresent) {
      try {
        const fontEntries = await readdir(fontDir, { withFileTypes: true });
        for (const entry of fontEntries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isFile() && /^(?:ofl|sil|fontlog|fonts?-license|license-fonts?)(?:[._-].*)?$/i.test(entry.name)) {
            const candidatePath = path.join(fontDir, entry.name);
            await checkedPath(candidatePath);
            fontLicenseDocumentPresent = true;
            fontLicenseDocumentName = entry.name;
            fontLicenseDocumentPath = candidatePath;
            break;
          }
        }
      } catch (error) {
        if (error.message?.includes('SOURCE_OUTSIDE_REPOSITORY')) throw error;
      }
    }

    if (fontLicenseDocumentPath) {
      try {
        installedOflBytes = await readFile(fontLicenseDocumentPath);
      } catch (error) {
        if (error.message?.includes('SOURCE_OUTSIDE_REPOSITORY')) throw error;
        unresolved.push({ kind: 'unreadable-installed-font-license-resource', path: relative(fontLicenseDocumentPath) });
      }
    } else {
      unresolved.push({
        kind: 'missing-installed-font-license-resource',
        package: mathlivePkg.manifest?.name ?? 'mathlive'
      });
    }
  } else {
    unresolved.push({ kind: 'missing-installed-package', package: 'mathlive' });
  }

  // 3b. Verify font embedded declarations from audited metadata and notices
  let fontMetadataVerified = false;
  let fontMetadataRecord = null;
  const fontMetadataPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
  const oflLicensePath = path.join(root, 'LICENSES/OFL-1.1.txt');
  const srcNoticesPath = path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md');
  const distNoticesPath = path.join(dist, 'THIRD_PARTY_NOTICES.md');

  let metaBytes = null;
  let oflBytes = null;
  let srcNoticesBytes = null;
  let distNoticesBytes = null;
  let missingLicensingFiles = false;

  try {
    metaBytes = await readFile(fontMetadataPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    missingLicensingFiles = true;
    unresolved.push({ kind: 'missing-font-metadata', path: relative(fontMetadataPath) });
    unresolved.push({ kind: 'missing-font-licensing-evidence-files' });
  }

  try {
    oflBytes = await readFile(oflLicensePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    missingLicensingFiles = true;
    unresolved.push({ kind: 'missing-ofl-license-file', path: relative(oflLicensePath) });
    if (!unresolved.some(u => u.kind === 'missing-font-licensing-evidence-files')) {
      unresolved.push({ kind: 'missing-font-licensing-evidence-files' });
    }
  }

  try {
    srcNoticesBytes = await readFile(srcNoticesPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    missingLicensingFiles = true;
    unresolved.push({ kind: 'missing-source-notices-file', path: relative(srcNoticesPath) });
    if (!unresolved.some(u => u.kind === 'missing-font-licensing-evidence-files')) {
      unresolved.push({ kind: 'missing-font-licensing-evidence-files' });
    }
  }

  try {
    distNoticesBytes = await readFile(distNoticesPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    missingLicensingFiles = true;
    unresolved.push({ kind: 'missing-emitted-notices-file', path: relative(distNoticesPath) });
    if (!unresolved.some(u => u.kind === 'missing-font-licensing-evidence-files')) {
      unresolved.push({ kind: 'missing-font-licensing-evidence-files' });
    }
  }

  if (metaBytes !== null) {
    let metadata = null;
    let parseError = false;
    try {
      metadata = JSON.parse(metaBytes.toString('utf8'));
    } catch {
      parseError = true;
      unresolved.push({ kind: 'font-metadata-corrupted' });
    }

    if (!parseError) {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        unresolved.push({ kind: 'font-metadata-corrupted' });
      } else if (!Array.isArray(metadata.fonts) || metadata.fonts.length !== 20) {
        unresolved.push({ kind: 'font-metadata-entry-count-invalid', count: Array.isArray(metadata.fonts) ? metadata.fonts.length : null });
      } else if (!missingLicensingFiles && oflBytes && srcNoticesBytes && distNoticesBytes) {
        const oflText = oflBytes.toString('utf8').replace(/\r\n/g, '\n').trim();
        const srcNoticesText = srcNoticesBytes.toString('utf8').replace(/\r\n/g, '\n').trim();
        const distNoticesText = distNoticesBytes.toString('utf8').replace(/\r\n/g, '\n').trim();
        const oflSha256 = digest(Buffer.from(oflText, 'utf8'));

        if (oflText.length === 0) {
          unresolved.push({ kind: 'font-notices-missing-ofl-text' });
        } else if (oflSha256 !== CANONICAL_OFL_1_1_SHA256) {
          unresolved.push({
            kind: 'tampered-or-mismatched-font-license-text',
            installedLicensePath: fontLicenseDocumentPath ? relative(fontLicenseDocumentPath) : null,
            repoLicensePath: relative(oflLicensePath)
          });
        } else if (!installedOflBytes) {
          // Trustworthy installed source evidence is absent; fail closed
        } else {
          const installedOflText = installedOflBytes.toString('utf8').replace(/\r\n/g, '\n').trim();
          const installedOflSha256 = digest(Buffer.from(installedOflText, 'utf8'));

          if (installedOflText.length === 0 || installedOflSha256 !== CANONICAL_OFL_1_1_SHA256 || installedOflText !== oflText) {
            unresolved.push({
              kind: 'tampered-or-mismatched-font-license-text',
              installedLicensePath: fontLicenseDocumentPath ? relative(fontLicenseDocumentPath) : null,
              repoLicensePath: relative(oflLicensePath)
            });
          } else if (!srcNoticesText.includes(oflText) || !distNoticesText.includes(oflText)) {
            unresolved.push({ kind: 'font-notices-missing-ofl-text' });
          } else {
            let metadataCorrupted = false;
            let duplicatePathDetected = false;
            let duplicateShaDetected = false;
            const uniqueName13 = new Set();
            const metaFontsByPath = new Map();
            const metaFontsBySha = new Map();

            for (const f of metadata.fonts) {
              if (
                !f ||
                typeof f !== 'object' ||
                Array.isArray(f) ||
                typeof f.path !== 'string' ||
                f.path.trim().length === 0 ||
                typeof f.sha256 !== 'string' ||
                !/^[0-9a-f]{64}$/i.test(f.sha256) ||
                !f.names ||
                typeof f.names !== 'object' ||
                Array.isArray(f.names) ||
                !Array.isArray(f.names['13']) ||
                f.names['13'].length === 0
              ) {
                metadataCorrupted = true;
                break;
              }

              const fontCandidate = path.resolve(root, f.path);
              if (!inside(root, fontCandidate)) {
                metadataCorrupted = true;
                break;
              }
              try {
                const fontResolved = await realpath(fontCandidate);
                if (!inside(root, fontResolved)) {
                  throw new Error(`SOURCE_OUTSIDE_REPOSITORY: ${f.path}`);
                }
              } catch (error) {
                if (error.message?.includes('SOURCE_OUTSIDE_REPOSITORY')) throw error;
              }

              if (metaFontsByPath.has(f.path)) {
                duplicatePathDetected = true;
                metadataCorrupted = true;
                break;
              }

              if (metaFontsBySha.has(f.sha256.toLowerCase())) {
                duplicateShaDetected = true;
                metadataCorrupted = true;
                break;
              }

              let allDeclsValid = true;
              for (const decl of f.names['13']) {
                if (typeof decl !== 'string' || decl.trim().length === 0) {
                  allDeclsValid = false;
                  break;
                }
              }
              if (!allDeclsValid) {
                metadataCorrupted = true;
                break;
              }

              metaFontsByPath.set(f.path, f);
              metaFontsBySha.set(f.sha256.toLowerCase(), f);
              for (const decl of f.names['13']) {
                uniqueName13.add(decl.trim());
              }
            }

            if (metadataCorrupted || metaFontsByPath.size !== 20 || metaFontsBySha.size !== 20) {
              unresolved.push({ kind: 'font-metadata-corrupted' });
              if (duplicatePathDetected) {
                unresolved.push({ kind: 'font-metadata-duplicate-path' });
              }
            } else {
              let declarationsMissingInNotices = false;
              for (const decl of uniqueName13) {
                const normDecl = decl.replace(/\r\n/g, '\n').trim();
                if (normDecl.length === 0 || !srcNoticesText.includes(normDecl) || !distNoticesText.includes(normDecl)) {
                  declarationsMissingInNotices = true;
                  break;
                }
              }

              if (declarationsMissingInNotices || uniqueName13.size === 0) {
                unresolved.push({ kind: 'font-notices-missing-embedded-declarations' });
              } else {
                // Check that 20 unique exact installed paths and hashes align bijectively
                let fontAlignmentMismatched = false;
                if (
                  installedFontsByPath.size !== 20 ||
                  installedFontsBySha.size !== 20 ||
                  metaFontsByPath.size !== 20 ||
                  metaFontsBySha.size !== 20
                ) {
                  fontAlignmentMismatched = true;
                } else {
                  for (const [metaPath, metaFont] of metaFontsByPath.entries()) {
                    const installed = installedFontsByPath.get(metaPath);
                    if (!installed || installed.sha256.toLowerCase() !== metaFont.sha256.toLowerCase()) {
                      fontAlignmentMismatched = true;
                      break;
                    }
                  }
                  if (!fontAlignmentMismatched) {
                    for (const [instPath, installed] of installedFontsByPath.entries()) {
                      const metaFont = metaFontsByPath.get(instPath);
                      if (!metaFont || metaFont.sha256.toLowerCase() !== installed.sha256.toLowerCase()) {
                        fontAlignmentMismatched = true;
                        break;
                      }
                    }
                  }
                }

                if (fontAlignmentMismatched) {
                  unresolved.push({ kind: 'font-metadata-hash-mismatch' });
                } else {
                  fontMetadataVerified = true;
                  fontMetadataRecord = {
                    metadataPath: relative(fontMetadataPath),
                    oflLicensePath: relative(oflLicensePath),
                    installedLicensePath: fontLicenseDocumentPath ? relative(fontLicenseDocumentPath) : null,
                    sourceNoticesPath: relative(srcNoticesPath),
                    emittedNoticesPath: relative(distNoticesPath),
                    auditedFontCount: metadata.fonts.length,
                    distinctName13Declarations: uniqueName13.size,
                    oflTextIncludedInSourceNotice: true,
                    oflTextIncludedInEmittedNotice: true,
                    installedLicenseAgreesWithRepoLicense: true
                  };
                }
              }
            }
          }
        }
      }
    }
  }

  // 4. Index ProseMirror source CSS
  let prosemirrorCssPath = null;
  if (prosemirrorPkg) {
    const styleCandidate = path.join(prosemirrorPkg.dir, 'style', 'prosemirror.css');
    try {
      await stat(styleCandidate);
      prosemirrorCssPath = styleCandidate;
    } catch {}
  }

  // 5. Verify PDF.js worker asset in dist
  const workerFiles = distFiles.filter(f => {
    const base = path.basename(f);
    return /^pdf\.worker(?:-[A-Za-z0-9_-]+)?\.mjs$/.test(base);
  });
  let pdfWorker = null;
  if (workerFiles.length === 0) {
    unresolved.push({ kind: 'missing-emitted-pdf-worker' });
  } else {
    for (const workerFile of workerFiles) {
      const bytes = await readFile(workerFile);
      const emittedSha = digest(bytes);
      const content = bytes.toString('utf8');
      const hasNoticeHeader = content.includes('@licstart') && content.includes('@licend');
      if (prebuiltWorker && emittedSha === prebuiltWorker.sha256) {
        pdfWorker = {
          emittedPath: relative(workerFile),
          installedSourcePath: relative(prebuiltWorker.path),
          package: pdfjsPkg?.manifest?.name ?? 'pdfjs-dist',
          version: pdfjsPkg?.manifest?.version ?? null,
          declaredLicense: pdfjsPkg?.manifest?.license ?? null,
          sha256: emittedSha,
          installedSha256: prebuiltWorker.sha256,
          bytes: bytes.length,
          byteMatch: true,
          licenseNoticeHeaderPresent: hasNoticeHeader
        };
      } else {
        unresolved.push({
          kind: 'tampered-or-mismatched-pdf-worker',
          path: relative(workerFile),
          emittedSha256: emittedSha,
          installedSha256: prebuiltWorker?.sha256 ?? null
        });
      }
    }
  }

  // 6. Inspect CSS sources for fonts and library styles
  const matchedFonts = [];
  const matchedFontFilenames = new Set();
  const cssFiles = distFiles.filter(f => f.endsWith('.css'));
  const woff2Files = distFiles.filter(f => f.endsWith('.woff2'));
  const cssSources = [];

  for (const cssFile of cssFiles) {
    const cssBytes = await readFile(cssFile);
    const cssContent = cssBytes.toString('utf8');

    if (cssContent.includes('.ProseMirror')) {
      cssSources.push({
        cssPath: relative(cssFile),
        identifiedSource: 'prosemirror-view',
        package: prosemirrorPkg?.manifest?.name ?? 'prosemirror-view',
        version: prosemirrorPkg?.manifest?.version ?? null,
        declaredLicense: prosemirrorPkg?.manifest?.license ?? null,
        sourceCssPath: prosemirrorCssPath ? relative(prosemirrorCssPath) : null,
        byteMatch: false,
        byteMatchNotice: 'transformed-by-build-pipeline-bytes-not-identical-to-source',
        matchedMarkers: ['.ProseMirror']
      });
    }

    if (cssContent.includes('--ML__static-fonts') || cssContent.includes('font-family:KaTeX_') || cssContent.includes('font-family:"KaTeX_')) {
      cssSources.push({
        cssPath: relative(cssFile),
        identifiedSource: 'mathlive',
        package: mathlivePkg?.manifest?.name ?? 'mathlive',
        version: mathlivePkg?.manifest?.version ?? null,
        declaredLicense: mathlivePkg?.manifest?.license ?? null,
        sourceCssPath: mathlivePkg ? portable(path.relative(root, path.join(mathlivePkg.dir, 'mathlive-fonts.css'))) : null,
        byteMatch: false,
        byteMatchNotice: 'transformed-by-build-pipeline-bytes-not-identical-to-source',
        matchedMarkers: ['--ML__static-fonts', 'KaTeX_'].filter(marker => cssContent.includes(marker))
      });
    }

    const URL_REGEX = /url\(\s*(?:(['"])(.*?)\1|([^)'"]+))\s*\)/gi;
    let match;
    while ((match = URL_REGEX.exec(cssContent)) !== null) {
      const rawTarget = (match[2] ?? match[3] ?? '').trim();
      if (!rawTarget) continue;

      if (rawTarget.startsWith('data:')) {
        const dataMatch = rawTarget.match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.+)$/i);
        if (dataMatch) {
          const mime = dataMatch[1].toLowerCase();
          const base64Data = dataMatch[2].trim();
          if (mime.includes('woff') || mime.includes('font') || mime.includes('octet-stream')) {
            const fontBuffer = Buffer.from(base64Data, 'base64');
            const fontSha = digest(fontBuffer);
            const installed = installedFontsBySha.get(fontSha);
            if (installed) {
              matchedFontFilenames.add(installed.filename);
              matchedFonts.push({
                originalFilename: installed.filename,
                sourceType: 'css-inline-base64',
                cssPath: relative(cssFile),
                package: 'mathlive',
                version: mathlivePkg?.manifest?.version ?? null,
                sha256: fontSha,
                bytes: fontBuffer.length,
                byteMatch: true,
                licenseStatus: fontLicenseDocumentPresent ? 'license-document-present' : 'license-document-missing'
              });
            } else {
              unresolved.push({
                kind: 'tampered-or-unknown-inline-font',
                cssPath: relative(cssFile),
                sha256: fontSha
              });
            }
          }
        }
        continue;
      }

      if (/^(?:https?:)?\/\//i.test(rawTarget)) {
        unresolved.push({
          kind: 'external-network-asset-url',
          cssPath: relative(cssFile),
          url: rawTarget
        });
        continue;
      }

      const cleanPath = rawTarget.split(/[?#]/)[0];
      const candidate = cleanPath.startsWith('/')
        ? path.resolve(dist, cleanPath.slice(1))
        : path.resolve(path.dirname(cssFile), cleanPath);

      if (!inside(root, candidate)) {
        throw new Error(`SOURCE_OUTSIDE_REPOSITORY: ${rawTarget}`);
      }

      if (cleanPath.endsWith('.woff2')) {
        try {
          await stat(candidate);
        } catch (error) {
          if (error.code === 'ENOENT') {
            unresolved.push({
              kind: 'missing-emitted-font-file',
              path: relative(candidate),
              cssSource: relative(cssFile)
            });
          } else {
            throw error;
          }
        }
      }
    }
  }

  // 7. Verify all emitted .woff2 font files in dist
  for (const fontFile of woff2Files) {
    const bytes = await readFile(fontFile);
    const fontSha = digest(bytes);
    const installed = installedFontsBySha.get(fontSha);
    if (installed) {
      matchedFontFilenames.add(installed.filename);
      matchedFonts.push({
        originalFilename: installed.filename,
        emittedPath: relative(fontFile),
        sourceType: 'emitted-file',
        package: 'mathlive',
        version: mathlivePkg?.manifest?.version ?? null,
        sha256: fontSha,
        bytes: bytes.length,
        byteMatch: true,
        licenseStatus: fontLicenseDocumentPresent ? 'license-document-present' : 'license-document-missing'
      });
    } else {
      unresolved.push({
        kind: 'tampered-or-unknown-font',
        path: relative(fontFile),
        sha256: fontSha
      });
    }
  }

  // 8. Completeness check: verify all installed fonts were matched
  for (const [filename, installed] of installedFontsByName.entries()) {
    if (!matchedFontFilenames.has(filename)) {
      unresolved.push({
        kind: 'missing-emitted-font',
        originalFilename: filename,
        sha256: installed.sha256
      });
    }
  }

  return {
    schemaVersion: 1,
    scope: relative(dist),
    verdict: 'asset-evidence-only-not-license-clearance',
    limitations: [
      'Binary hash equivalence confirms byte identity with installed npm assets, but does not constitute legal clean-room clearance.',
      'MathLive package (0.110.0) distributes KaTeX font binaries without an explicit standalone font license document (e.g., OFL.txt); licenseStatus is reported as license-document-missing.',
      'CSS files emitted by bundler undergo code extraction and minification; byte identity to source CSS cannot be claimed, but structural source signatures are identified.'
    ],
    pdfWorker,
    fontEmbeddedDeclarations: fontMetadataVerified ? fontMetadataRecord : null,
    fonts: matchedFonts.sort((a, b) => a.originalFilename.localeCompare(b.originalFilename)),
    cssSources: cssSources.sort((a, b) => a.cssPath.localeCompare(b.cssPath) || a.identifiedSource.localeCompare(b.identifiedSource)),
    unresolved
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await collectAssetProvenance(process.cwd());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
