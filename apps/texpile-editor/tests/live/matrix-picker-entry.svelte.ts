import '../../src/app.css';
import 'mathlive/static.css';
import { flushSync, mount, unmount } from 'svelte';
import { initVirtualKeyboardInCurrentBrowsingContext, MathfieldElement } from 'mathlive';
import MathSymbolPanel from '../../src/lib/editor/comp/toolbar/MathSymbolPanel.svelte';
import { liveMathfield } from '../../src/lib/editor/comp/toolbar/mathInsert';

type FieldSnapshot = {
	connected: boolean;
	hasFocus: boolean;
	latex: string;
	maxMatrixCols: number;
	selection: { ranges: Array<[number, number]>; direction?: string };
	selectedLatex: string;
	selectedElementLatex: string | undefined;
};

type MatrixPickerFixture = {
	closeCount: number;
	openPanel(): void;
	unmountPanel(): Promise<void>;
	reset(): Promise<void>;
	setIntendedDisabled(disabled: boolean): void;
	removeIntended(): void;
	restoreIntended(): void;
	setIntendedMaxMatrixCols(value: number): void;
	getSnapshot(): {
		intended: FieldSnapshot;
		other: FieldSnapshot;
		closeCount: number;
		panelOpen: boolean;
		openingFieldId: string | null;
		focusEvents: Array<{ targetTag: string; targetId: string; liveFieldId: string | null }>;
		maxColsAtBeforeInput: number[];
	};
	getFocusDebug(): {
		documentActive: { tag: string; id: string; constructor: string };
		activeChain: Array<{ tag: string; id: string; constructor: string; hostId: string | null }>;
		fieldHasFocus: boolean;
		fieldShadowActive: { tag: string; id: string; constructor: string } | null;
		liveFieldId: string | null;
		classMatches: boolean;
	};
	installThrowingExecuteCommand(): void;
	restoreExecuteCommand(): void;
	getThrowObservation(): { calls: number; maxCols: number[] };
};

declare global {
	interface Window {
		__matrixPicker?: MatrixPickerFixture;
		__matrixPickerReady?: boolean;
	}
}

initVirtualKeyboardInCurrentBrowsingContext();

const fieldsRoot = document.querySelector<HTMLElement>('#fixture-fields');
if (!fieldsRoot) throw new Error('Missing live fixture field root');

const maxColsAtBeforeInput: number[] = [];

function createField(id: string, label: string, value: string): MathfieldElement {
	const field = document.createElement('math-field') as MathfieldElement;
	field.id = id;
	field.setAttribute('aria-label', label);
	field.mathVirtualKeyboardPolicy = 'manual';
	field.maxMatrixCols = 8;
	fieldsRoot.append(field);
	field.setValue(value);
	if (id === 'intended-mathfield') {
		field.addEventListener(
			'beforeinput',
			() => {
				maxColsAtBeforeInput.push(field.maxMatrixCols);
			},
			true
		);
	}
	return field;
}

const intended = createField('intended-mathfield', 'Intended MathLive field', 'x');
const other = createField('other-mathfield', 'Other MathLive field', 'y');

let openingFieldId: string | null = null;
const focusEvents: Array<{ targetTag: string; targetId: string; liveFieldId: string | null }> = [];
document.addEventListener('focusin', (event) => {
	const target = event.target;
	focusEvents.push({
		targetTag: target instanceof Element ? target.tagName : '',
		targetId: target instanceof Element ? target.id : '',
		liveFieldId: liveMathfield()?.id ?? null
	});
});

let panel: Record<string, unknown> | null = null;
let panelHost: HTMLDivElement | null = null;
let closeCount = 0;
let throwingCommandDescriptor: PropertyDescriptor | undefined;
let throwCalls = 0;
const throwMaxCols: number[] = [];

function unmountCurrentPanel(): Promise<void> {
	const current = panel;
	panel = null;
	panelHost?.remove();
	panelHost = null;
	return current ? unmount(current).then(() => undefined) : Promise.resolve();
}

function snapshotField(field: MathfieldElement): FieldSnapshot {
	const selection = field.selection;
	const firstRange = selection.ranges[0];
	return {
		connected: field.isConnected,
		hasFocus: field.hasFocus(),
		latex: field.getValue('latex'),
		maxMatrixCols: field.maxMatrixCols,
		selection: { ranges: selection.ranges.map(([start, end]) => [start, end]), direction: selection.direction },
		selectedLatex: field.getValue(selection, 'latex'),
		selectedElementLatex: firstRange ? field.getElementInfo(firstRange[0])?.latex : undefined
	};
}

const fixture: MatrixPickerFixture = {
	get closeCount() {
		return closeCount;
	},
	openPanel() {
		if (panel) throw new Error('Panel is already open');
		openingFieldId = liveMathfield()?.id ?? null;
		panelHost = document.createElement('div');
		panelHost.dataset.matrixPickerHost = 'true';
		document.body.append(panelHost);
		panel = mount(MathSymbolPanel, {
			target: panelHost,
			props: {
				groupId: 'matrices',
				top: 0,
				left: 0,
				onClose: () => {
					closeCount += 1;
					void unmountCurrentPanel();
				}
			}
		});
		flushSync();
	},
	unmountPanel: unmountCurrentPanel,
	async reset() {
		await unmountCurrentPanel();
		this.restoreExecuteCommand();
		intended.disabled = false;
		other.disabled = false;
		intended.inert = false;
		other.inert = false;
		if (!intended.isConnected) fieldsRoot.append(intended);
		if (!other.isConnected) fieldsRoot.append(other);
		intended.blur();
		other.blur();
		closeCount = 0;
		openingFieldId = null;
		focusEvents.length = 0;
		intended.maxMatrixCols = 8;
		other.maxMatrixCols = 8;
		intended.setValue('x');
		other.setValue('y');
		maxColsAtBeforeInput.length = 0;
		throwCalls = 0;
		throwMaxCols.length = 0;
	},
	setIntendedDisabled(disabled) {
		intended.disabled = disabled;
	},
	removeIntended() {
		intended.remove();
	},
	restoreIntended() {
		if (!intended.isConnected) fieldsRoot.append(intended);
	},
	setIntendedMaxMatrixCols(value) {
		intended.maxMatrixCols = value;
	},
	getSnapshot() {
		return {
			intended: snapshotField(intended),
			other: snapshotField(other),
			closeCount,
			panelOpen: !!panelHost?.isConnected && !!panelHost.querySelector('.card'),
			openingFieldId,
			focusEvents: [...focusEvents],
			maxColsAtBeforeInput: [...maxColsAtBeforeInput]
		};
	},
	getFocusDebug() {
		const basic = (element: Element | null) => ({
			tag: element?.tagName ?? '',
			id: element?.id ?? '',
			constructor: element?.constructor?.name ?? ''
		});
		const activeChain: Array<{ tag: string; id: string; constructor: string; hostId: string | null }> = [];
		const seen = new Set<Node>();
		let active: Element | ShadowRoot | null = document.activeElement;
		while (active && !seen.has(active)) {
			seen.add(active);
			const item = basic(active instanceof ShadowRoot ? active.host : active);
			activeChain.push({ ...item, hostId: active instanceof ShadowRoot ? (active.host as HTMLElement).id : null });
			if (active instanceof ShadowRoot) active = active.activeElement ?? active.host;
			else if (active.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
			else active = active.parentNode instanceof ShadowRoot ? active.parentNode : null;
		}
		return {
			documentActive: basic(document.activeElement),
			activeChain,
			fieldHasFocus: intended.hasFocus(),
			fieldShadowActive: intended.shadowRoot?.activeElement ? basic(intended.shadowRoot.activeElement) : null,
			liveFieldId: liveMathfield()?.id ?? null,
			classMatches: intended instanceof window.MathfieldElement
		};
	},
	installThrowingExecuteCommand() {
		if (throwingCommandDescriptor !== undefined) throw new Error('Throw fixture is already installed');
		throwingCommandDescriptor = Object.getOwnPropertyDescriptor(intended, 'executeCommand');
		Object.defineProperty(intended, 'executeCommand', {
			configurable: true,
			writable: true,
			value: () => {
				throwCalls += 1;
				throwMaxCols.push(intended.maxMatrixCols);
				throw new Error('Intentional negative-only MathLive command failure');
			}
		});
	},
	restoreExecuteCommand() {
		if (throwingCommandDescriptor === undefined) return;
		if (throwingCommandDescriptor) Object.defineProperty(intended, 'executeCommand', throwingCommandDescriptor);
		else Reflect.deleteProperty(intended, 'executeCommand');
		throwingCommandDescriptor = undefined;
	},
	getThrowObservation() {
		return { calls: throwCalls, maxCols: [...throwMaxCols] };
	}
};

window.__matrixPicker = fixture;
window.__matrixPickerReady = true;
