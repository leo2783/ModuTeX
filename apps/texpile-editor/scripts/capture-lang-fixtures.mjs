// Regenerates tests/fixtures/lang from a real engine run -- nothing else.
//
// Each .tex there is compiled through EXACTLY the job string draft-service.ts builds (the
// page-extract hook, -no-shell-escape, -output-directory, -jobname=draft), so the captured
// page-001.jsonl and pages.json are the same bytes the app would hand the renderer. The tests
// then assert against real luaotfload output instead of a hand-written idea of it.
//
//   node scripts/capture-lang-fixtures.mjs
//
// Needs lualatex on PATH and the fonts each case names. Cases whose fonts are missing on this
// machine are reported and skipped, not silently written empty. Absolute font paths differ per
// machine by design -- the tests assert on record SHAPE, never on a path.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'tests', 'fixtures', 'lang');
const lua = path.join(here, '..', '..', '..', 'electron', 'lua').replace(/\\/g, '/');

const cases = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith('.tex'))
	.map((f) => f.replace(/\.tex$/, ''));

const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'texpile-lang-'));
let failed = 0;

for (const name of cases) {
	fs.copyFileSync(path.join(dir, `${name}.tex`), path.join(tmp, `${name}.tex`));
	// lualatex will not create -output-directory itself, and page-extract writes its jsonl there too
	fs.mkdirSync(path.join(tmp, '_draft'), { recursive: true });
	const job =
		`\\directlua{TEXPILE_ENGINE_DIR='${lua}'; TEXPILE_DRAFT_OUT='_draft'; dofile('${lua}/page-extract.lua')}` +
		`\\AtBeginDocument{\\AddToHook{shipout/before}{\\directlua{page_extract(\\the\\ShipoutBox)}}` +
		`\\AtEndDocument{\\directlua{page_extract_finish()}}}` +
		`\\ifdefined\\pdfoutput\\else\\newcount\\pdfoutput\\fi\\input{${name}.tex}`;
	try {
		execFileSync('lualatex', ['-no-shell-escape', '-interaction=nonstopmode', '-output-directory=_draft', '-jobname=draft', job], {
			cwd: tmp,
			stdio: 'ignore',
			timeout: 120000
		});
	} catch {
		/* nonstopmode exits nonzero on any error; the manifest check below is the real verdict */
	}
	const out = path.join(tmp, '_draft');
	const manifest = path.join(out, 'pages.json');
	const page = path.join(out, 'page-001.jsonl');
	if (!fs.existsSync(manifest) || !fs.existsSync(page)) {
		console.error(`SKIP ${name}: no pages produced (missing font, or the engine errored)`);
		failed++;
		continue;
	}
	fs.copyFileSync(manifest, path.join(dir, `${name}.pages.json`));
	fs.copyFileSync(page, path.join(dir, `${name}.jsonl`));
	const unc = JSON.parse(fs.readFileSync(manifest, 'utf8')).pages[0].unc;
	console.log(`ok   ${name}${unc ? ` (uncertified: ${unc})` : ''}`);
	fs.rmSync(out, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exitCode = 1;
