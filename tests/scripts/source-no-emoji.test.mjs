// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const excluded = new Set([
    '.git', '.agents', '.codex', '.verification-artifacts', '.worktrees',
    'node_modules', 'target', 'dist', 'dist-tauri', 'build', 'gen', 'vendor', 'coverage'
]);
const source = /\.(?:rs|ts|tsx|js|jsx|mjs|cjs|svelte|py|ps1|css|html|json|ya?ml|toml|md|mdx|txt|svg|lua|tex|sh|cmd|bat)$/i;
const emoji = /\p{Emoji_Presentation}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;
const mathematicalData = new Set([
    'apps/frontend/src/features/math/catalog.ts',
    'docs/archive/frontend-operations-2026-10-11.html'
]);
const mathematicalSymbol = /^[\u2194\u2195\u2196\u2197\u2198\u2199\u21A9\u21AA\u25B6\u25C0\u2640\u2642\u2660\u2663]$/u;
const legalMark = /^[\u00A9\u00AE]$/u;

function decodeEscapes(value) {
    return value.replace(/\\u\{([\da-f]{1,6})\}|\\u([\da-f]{4})|&#x([\da-f]{1,6});|&#(\d{1,7});|\\([\da-f]{4,6})\s?/gi,
        (original, rust, js, hexEntity, decimalEntity, css) => {
            const point = Number.parseInt(rust ?? js ?? hexEntity ?? decimalEntity ?? css, decimalEntity ? 10 : 16);
            return point <= 0x10ffff ? String.fromCodePoint(point) : original;
        });
}

function hasEmoji(value, file) {
    return emoji.test(value) || [...value.matchAll(/\p{Extended_Pictographic}/gu)]
        .some(([symbol]) => !legalMark.test(symbol) &&
            !(mathematicalData.has(file) && mathematicalSymbol.test(symbol)));
}

test('encoded emoji cannot bypass the source check; astral CJK retains Unicode coverage', () => {
    const slash = String.fromCharCode(92);
    for (const encoded of [slash + 'ud83d' + slash + 'ude00', slash + 'u{1f600}', '&#x1f600;', '&#128512;', slash + '01f600 ']) {
        assert(hasEmoji(decodeEscapes(encoded), 'apps/frontend/src/example.ts'));
    }
    assert(hasEmoji(String.fromCodePoint(0x1f1f9, 0x1f1fc), 'example.ts'));
    assert(!hasEmoji(String.fromCodePoint(0x20000), 'example.ts'));
    assert.equal(Buffer.byteLength(String.fromCodePoint(0x20000)), 4);
    assert.equal(String.fromCodePoint(0x20000).length, 2);
});

test('repository source contains no literal or encoded emoji; Unicode fixtures use non-emoji characters', async () => {
    const violations = [];
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0');
    for (const file of files) {
        if (!source.test(file) || file.split('/').some(part => excluded.has(part))) continue;
        let contents;
        try { contents = await readFile(join(root, file), 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const lines = contents.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            // Detector expressions and immutable upstream funding metadata are not UI content.
            const upstreamFunding = file === 'package-lock.json' && /^\s*"type": "GitHub Sponsors \\u2764",?\s*$/.test(line);
            const decoded = file === 'tests/scripts/source-no-emoji.test.mjs' || upstreamFunding ? line : decodeEscapes(line);
            if (hasEmoji(line, file) || hasEmoji(decoded, file)) violations.push(`${file}:${index + 1}`);
        }
    }
    assert.deepEqual(violations, [], 'Replace emoji at its source; use non-emoji astral Unicode fixtures without losing coverage.');
});
