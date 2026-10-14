import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { parse } from 'svelte/compiler';

const roots = ['apps/frontend/src', 'packages/document-core/src', 'packages/frontend-contracts/src'];
const portable = value => value.split(path.sep).join('/');
const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

// Static boundary evidence only: this does not decide copyright or license compatibility.
export async function inspectFrontendBoundaries(rootDirectory) {
  const root = await realpath(rootDirectory);
  const relative = value => portable(path.relative(root, value));
  const findings = [];
  const references = [];
  const files = [];
  const add = (kind, filename, detail) => findings.push({ kind, path: relative(filename), detail });
  const configPath = path.join(root, 'apps/frontend/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error('INVALID_FRONTEND_TSCONFIG');
  const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const options = parsedConfig.options;

  async function walk(directory) {
    const actual = await realpath(directory);
    if (!within(root, actual)) throw new Error('SOURCE_OUTSIDE_REPOSITORY');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) add('source-symlink', filename, 'Source links require explicit review');
      else if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  for (const item of roots) await walk(path.join(root, item));
  const localRoots = roots.map(item => path.join(root, item));
  const manifest = JSON.parse(await readFile(path.join(root, 'docs/licensing/frontend-origin.json'), 'utf8'));
  const allowedDocuments = new Set(manifest.bundledDocuments?.files ?? []);
  const generatedRoots = (manifest.generated ?? []).map(item => path.resolve(root, item.path))
    .filter(directory => ['packages/document-core/dist', 'packages/frontend-contracts/dist'].includes(relative(directory)));

  async function reference(filename, value, kind) {
    if (typeof value !== 'string') { add('computed-module-reference', filename, kind); return; }
    references.push({ path: relative(filename), specifier: value, kind });
    const clean = value.split(/[?#]/)[0];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(clean) || clean.startsWith('/')) {
      add('external-module-reference', filename, value); return;
    }
    let candidate;
    if (clean.startsWith('.')) {
      candidate = path.resolve(path.dirname(filename), clean);
      try { candidate = await realpath(candidate); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        candidate = ts.resolveModuleName(clean, filename, options, ts.sys).resolvedModule?.resolvedFileName;
      }
    } else {
      candidate = ts.resolveModuleName(clean, filename, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!candidate) {
        try { candidate = createRequire(filename).resolve(clean); } catch {}
      }
    }
    if (!candidate) { add('unresolved-module-reference', filename, value); return; }
    candidate = await realpath(candidate);
    if (!within(root, candidate)) { add('reference-outside-repository', filename, value); return; }
    const target = relative(candidate);
    const local = [...localRoots, ...generatedRoots].some(directory => within(directory, candidate));
    const library = /(?:^|\/)node_modules\//.test(target);
    const document = kind === 'import' && value.endsWith('?raw') && allowedDocuments.has(target);
    if (!local && !library && !document) add('reference-outside-new-frontend', filename, target);
  }

  function isTsImportMetaGlob(node) {
    if (!ts.isCallExpression(node)) return false;
    let expr = node.expression;
    let prop;
    if (ts.isPropertyAccessExpression(expr)) {
      prop = expr.name.text;
      expr = expr.expression;
    } else if (ts.isElementAccessExpression(expr) && expr.argumentExpression && ts.isStringLiteralLike(expr.argumentExpression)) {
      prop = expr.argumentExpression.text;
      expr = expr.expression;
    } else {
      return false;
    }
    if (prop !== 'glob') return false;
    while (expr && ts.isParenthesizedExpression(expr)) expr = expr.expression;
    return Boolean(expr && (ts.isMetaProperty?.(expr) || expr.kind === ts.SyntaxKind.MetaProperty) &&
      expr.keywordToken === ts.SyntaxKind.ImportKeyword && expr.name.text === 'meta');
  }

  function isSvelteImportMetaGlob(node) {
    if (!node || node.type !== 'CallExpression' || !node.callee) return false;
    const callee = node.callee;
    if (callee.type !== 'MemberExpression') return false;
    let prop;
    if (!callee.computed && callee.property?.type === 'Identifier') prop = callee.property.name;
    else if (callee.computed && callee.property?.type === 'Literal') prop = callee.property.value;
    else return false;
    if (prop !== 'glob') return false;
    let obj = callee.object;
    while (obj && obj.type === 'ParenthesizedExpression') obj = obj.expression;
    return Boolean(obj && obj.type === 'MetaProperty' && obj.meta?.name === 'import' && obj.property?.name === 'meta');
  }

  function tsReferences(filename, code) {
    const ast = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true);
    const items = [];
    const literal = node => node && ts.isStringLiteralLike(node) ? node.text : undefined;
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        items.push([literal(node.moduleSpecifier), 'import']);
      } else if (ts.isImportTypeNode(node)) {
        items.push([ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : undefined, 'type-import']);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        items.push([literal(node.arguments[0]), 'dynamic-import']);
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        items.push([literal(node.arguments[0]), 'require']);
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
        items.push([literal(node.arguments?.[0]), 'asset-url']);
      } else if (ts.isCallExpression(node) && isTsImportMetaGlob(node)) {
        const arg = node.arguments[0];
        const pattern = arg && ts.isStringLiteralLike(arg) ? arg.text : (arg ? arg.getText(ast) : 'import.meta.glob');
        add('unresolved-glob-expansion', filename, pattern);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    if (ast.parseDiagnostics.length) add('source-parse-error', filename, 'TypeScript parse diagnostics');
    return items;
  }

  function svelteReferences(filename, code) {
    const ast = parse(code, { modern: true });
    const items = [];
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
        items.push([node.source.type === 'Literal' ? node.source.value : undefined, node.type === 'ImportExpression' ? 'dynamic-import' : 'import']);
      }
      if ((node.type === 'CallExpression' && node.callee?.name === 'require') || (node.type === 'NewExpression' && node.callee?.name === 'URL')) {
        items.push([node.arguments?.[0]?.type === 'Literal' ? node.arguments[0].value : undefined, node.callee.name === 'URL' ? 'asset-url' : 'require']);
      }
      if (node.type === 'CallExpression' && isSvelteImportMetaGlob(node)) {
        const arg = node.arguments?.[0];
        const pattern = arg?.type === 'Literal' && typeof arg.value === 'string'
          ? arg.value
          : (arg?.raw ?? (arg && arg.start != null && arg.end != null ? code.slice(arg.start, arg.end) : 'import.meta.glob'));
        add('unresolved-glob-expansion', filename, pattern);
      }
      // Includes imports in {#await ...} template expressions, not just script blocks.
      for (const [key, value] of Object.entries(node)) {
        if (['parent', 'loc', 'metadata'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(ast);
    items.push(...cssReferences(ast.css?.content?.styles ?? ''));
    return items;
  }

  function cssReferences(css) {
    return [...css.matchAll(/(?:@import\s+(['"])(.*?)\1|url\(\s*(['"]?)([^)'"\s]+)\3\s*\))/g)]
      .map(match => [match[2] ?? match[4], 'css-asset']);
  }

  for (const filename of files) {
    const code = await readFile(filename, 'utf8');
    let items = [];
    try {
      if (/\.[cm]?[jt]sx?$/.test(filename)) items = tsReferences(filename, code);
      else if (filename.endsWith('.svelte')) items = svelteReferences(filename, code);
      else if (filename.endsWith('.css')) items = cssReferences(code);
    } catch { add('source-parse-error', filename, 'Source parse failed'); }
    for (const [value, kind] of items) await reference(filename, value, kind);
  }
  // TypeScript path aliases are resolved above. Vite-specific aliases/plugins must
  // also be traced through the real output maps; arbitrary alias expressions fail closed.
  const vitePath = path.join(root, 'apps/frontend/vite.config.ts');
  const viteAst = ts.createSourceFile(vitePath, await readFile(vitePath, 'utf8'), ts.ScriptTarget.Latest, true);
  function inspectConfig(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(viteAst).replace(/['"]/g, '') === 'alias') {
      add('vite-alias-review-required', vitePath, 'Resolve plugin/config aliases independently before clearance');
    }
    ts.forEachChild(node, inspectConfig);
  }
  inspectConfig(viteAst);
  return { verdict: 'static-boundary-evidence-only', files: files.map(relative), references, findings };
}
