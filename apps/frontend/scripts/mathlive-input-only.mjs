import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const upstream = new URL('../../../node_modules/mathlive/mathlive.mjs', import.meta.url);
const digest = '5102f07f98461e1e34605bc81362dce2343dade9d60b6c311f1109b7f89c7374';

/** Pinned MIT upstream input core. Virtual-keyboard modules never reach the browser. */
export function inputOnlyMathLive(source) {
	if (createHash('sha256').update(source).digest('hex') !== digest) throw new Error('MathLive input-only patch requires audited 0.110.0 source');
	const sections = source.split(/(?=^\/\/ src\/)/m);
	const removed = sections.filter(section => section.startsWith('// src/virtual-keyboard/'));
	if (removed.length !== 8) throw new Error('MathLive virtual-keyboard module inventory changed');
	let core = sections.filter(section => !section.startsWith('// src/virtual-keyboard/')).join('');
	core = core.replaceAll('window.mathVirtualKeyboard', 'mathInputHost')
		.replace('mathVirtualKeyboardPolicy: "auto"', 'mathVirtualKeyboardPolicy: "manual"')
		.replace('  mountMathVirtualKeyboard as initVirtualKeyboardInCurrentBrowsingContext,\n', '')
		.replaceAll('mountMathVirtualKeyboard()', 'mathInputHost')
		.replace('  { key: "alt+shift+[Space]", command: "toggleVirtualKeyboard" },\n', '')
		.replace(/    if \(mathInputHost\) \{\n      markup\.push\([\s\S]*?\n    \}\n(?=    markup\.push)/, '');
	// The mathfield lifecycle still calls a platform host; it has no UI, layouts,
	// messages, global registration or keyboard commands. It is not a keyboard.
	const host = `
const mathInputHost = Object.assign(new EventTarget(), {
 visible: false, boundingRect: { height: 0, width: 0 },
 connect() {}, disconnect() {}, update() {}, show() {}, hide() {},
 executeCommand() { return false; }
});
const isVirtualKeyboardMessage = () => false;
const makeProxy = () => null;
`;
	return core.replace('/** MathLive 0.110.0 */', '/** MathLive 0.110.0 — MIT, ModuTeX input-only build; virtual-keyboard modules omitted. */' + host);
}

export function mathLiveInputOnlyPlugin() {
	const generated = new URL('../../../.verification-artifacts/mathlive-input/runtime.mjs', import.meta.url);
	let prepared;
	async function prepare() {
		const code = inputOnlyMathLive(await readFile(upstream, 'utf8'));
		await mkdir(new URL('./', generated), { recursive: true });
		if (await readFile(generated, 'utf8').catch(() => null) !== code) await writeFile(generated, code, 'utf8');
		return fileURLToPath(generated);
	}
	return {
		name: 'mathlive-input-only', enforce: 'pre',
		resolveId(source, _importer, options) { if (source === 'mathlive' && !options?.ssr) return prepared ??= prepare(); }
	};
}
