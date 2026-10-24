import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { parse } from 'svelte/compiler';

const roots = ['apps/frontend/src', 'packages/frontend-contracts/src'];
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
    .filter(directory => ['packages/frontend-contracts/dist'].includes(relative(directory)));

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

  function isTsImportMetaUrl(node) {
    if (!node) return false;
    let expr = node;
    while (expr && ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (!expr) return false;
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
    if (prop !== 'url') return false;
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

  function isSvelteImportMetaUrl(node) {
    if (!node) return false;
    let expr = node;
    while (expr && expr.type === 'ParenthesizedExpression') expr = expr.expression;
    if (!expr || expr.type !== 'MemberExpression') return false;
    let prop;
    if (!expr.computed && expr.property?.type === 'Identifier') prop = expr.property.name;
    else if (expr.computed && expr.property?.type === 'Literal') prop = expr.property.value;
    else return false;
    if (prop !== 'url') return false;
    let obj = expr.object;
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
        const args = node.arguments ?? [];
        if (isTsImportMetaUrl(args[1])) {
          items.push([literal(args[0]), 'asset-url']);
        }
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
      if (node.type === 'CallExpression' && node.callee?.name === 'require') {
        items.push([node.arguments?.[0]?.type === 'Literal' ? node.arguments[0].value : undefined, 'require']);
      } else if (
        node.type === 'NewExpression' &&
        node.callee?.name === 'URL' &&
        isSvelteImportMetaUrl(node.arguments?.[1])
      ) {
        items.push([node.arguments?.[0]?.type === 'Literal' ? node.arguments[0].value : undefined, 'asset-url']);
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
    items.push(...cssReferences(ast.css?.content?.styles ?? '', filename));
    return items;
  }

  const MAX_CSS_BYTES = 8 * 1024 * 1024;
  const MAX_CSS_REFERENCES = 10_000;

  function skipWhitespaceAndComments(css, i) {
    const len = css.length;
    while (i < len) {
      const ch = css[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
        i++;
      } else if (ch === '/' && i + 1 < len && css[i + 1] === '*') {
        const endComment = css.indexOf('*/', i + 2);
        if (endComment === -1) return len;
        i = endComment + 2;
      } else {
        break;
      }
    }
    return i;
  }

  function unescapeCss(str) {
    return str.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|(\r\n|[\r\n\f])|([\s\S]))/g, (_, hex, nl, ch) => {
      if (hex) {
        const code = parseInt(hex, 16);
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
        return String.fromCodePoint(code);
      }
      if (nl) return '';
      return ch ?? '';
    });
  }

  function cssReferences(css, filename) {
    if (typeof css !== 'string' || !css) return [];
    if (css.length > MAX_CSS_BYTES) {
      if (filename) add('source-parse-error', filename, 'CSS file size limit exceeded');
      return [];
    }
    const items = [];
    const len = css.length;
    let i = 0;
    while (i < len) {
      const ch = css[i];
      if (ch === '/' && i + 1 < len && css[i + 1] === '*') {
        const endComment = css.indexOf('*/', i + 2);
        if (endComment === -1) break;
        i = endComment + 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        while (i < len) {
          if (css[i] === '\\') {
            i += 2;
          } else if (css[i] === quote) {
            i++;
            break;
          } else if (css[i] === '\n' || css[i] === '\r') {
            break;
          } else {
            i++;
          }
        }
        continue;
      }
      if (ch === '@') {
        if (css.slice(i, i + 7).toLowerCase() === '@import') {
          const after = i + 7;
          if (after >= len || !/[a-zA-Z0-9_-]/.test(css[after])) {
            i = skipWhitespaceAndComments(css, after);
            if (i < len && (css[i] === "'" || css[i] === '"')) {
              const quote = css[i];
              i++;
              let raw = '';
              let closed = false;
              while (i < len) {
                const c = css[i];
                if (c === '\\') {
                  if (i + 1 < len) { raw += css.slice(i, i + 2); i += 2; }
                  else i++;
                } else if (c === quote) {
                  closed = true;
                  i++;
                  break;
                } else if (c === '\n' || c === '\r') {
                  break;
                } else {
                  raw += c;
                  i++;
                }
              }
              if (closed) {
                const specifier = unescapeCss(raw);
                if (specifier) {
                  if (items.length < MAX_CSS_REFERENCES) {
                    items.push([specifier, 'css-asset']);
                  } else {
                    if (filename) add('source-parse-error', filename, 'CSS reference limit exceeded');
                    break;
                  }
                }
              }
              while (i < len && css[i] !== ';' && css[i] !== '}') {
                if (css[i] === '/' && i + 1 < len && css[i + 1] === '*') {
                  const endComment = css.indexOf('*/', i + 2);
                  if (endComment === -1) { i = len; break; }
                  i = endComment + 2;
                } else if (css[i] === "'" || css[i] === '"') {
                  const q = css[i];
                  i++;
                  while (i < len && css[i] !== q && css[i] !== '\n' && css[i] !== '\r') {
                    if (css[i] === '\\') i += 2; else i++;
                  }
                  if (i < len && css[i] === q) i++;
                } else {
                  i++;
                }
              }
              if (i < len && css[i] === ';') i++;
              continue;
            }
            continue;
          }
        }
      }
      if ((ch === 'u' || ch === 'U') && i + 4 <= len && css.slice(i, i + 4).toLowerCase() === 'url(') {
        if (i === 0 || !/[a-zA-Z0-9_-]/.test(css[i - 1])) {
          let p = skipWhitespaceAndComments(css, i + 4);
          if (p >= len) break;
          const nextCh = css[p];
          if (nextCh === "'" || nextCh === '"') {
            const quote = nextCh;
            p++;
            let raw = '';
            let closedQuote = false;
            while (p < len) {
              const c = css[p];
              if (c === '\\') {
                if (p + 1 < len) { raw += css.slice(p, p + 2); p += 2; }
                else p++;
              } else if (c === quote) {
                closedQuote = true;
                p++;
                break;
              } else if (c === '\n' || c === '\r') {
                break;
              } else {
                raw += c;
                p++;
              }
            }
            if (closedQuote) {
              p = skipWhitespaceAndComments(css, p);
              if (p < len && css[p] === ')') {
                p++;
                const specifier = unescapeCss(raw);
                if (specifier) {
                  if (items.length < MAX_CSS_REFERENCES) {
                    items.push([specifier, 'css-asset']);
                  } else {
                    if (filename) add('source-parse-error', filename, 'CSS reference limit exceeded');
                    break;
                  }
                }
              }
            }
            i = p;
            continue;
          } else if (nextCh === ')') {
            i = p + 1;
            continue;
          } else {
            let raw = '';
            let closed = false;
            let badUrl = false;
            while (p < len) {
              const c = css[p];
              if (c === '\\') {
                if (p + 1 < len) { raw += css.slice(p, p + 2); p += 2; }
                else p++;
              } else if (c === ')') {
                closed = true;
                p++;
                break;
              } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
                p = skipWhitespaceAndComments(css, p);
                if (p < len && css[p] === ')') {
                  closed = true;
                  p++;
                } else {
                  badUrl = true;
                }
                break;
              } else if (c === '"' || c === "'" || c === '(' || c <= '\x08' || c === '\x0b' || (c >= '\x0e' && c <= '\x1f') || c === '\x7f') {
                badUrl = true;
                break;
              } else {
                raw += c;
                p++;
              }
            }
            if (badUrl) {
              while (p < len) {
                if (p + 1 < len && css[p] === '\\') {
                  p += 2;
                } else if (css[p] === ')') {
                  p++;
                  break;
                } else {
                  p++;
                }
              }
            } else if (closed) {
              const specifier = unescapeCss(raw);
              if (specifier) {
                if (items.length < MAX_CSS_REFERENCES) {
                  items.push([specifier, 'css-asset']);
                } else {
                  if (filename) add('source-parse-error', filename, 'CSS reference limit exceeded');
                  break;
                }
              }
            }
            i = p;
            continue;
          }
        }
      }
      i++;
    }
    return items;
  }

  for (const filename of files) {
    const code = await readFile(filename, 'utf8');
    let items = [];
    try {
      if (/\.[cm]?[jt]sx?$/.test(filename)) items = tsReferences(filename, code);
      else if (filename.endsWith('.svelte')) items = svelteReferences(filename, code);
      else if (filename.endsWith('.css')) items = cssReferences(code, filename);
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
