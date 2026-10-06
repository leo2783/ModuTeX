// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '$lib/schema/schema';
import { createTableNode } from '$lib/editor/utils/tableUtils';
import { m } from '$lib/paraglide/messages';
import TableWrapperComponent from '$lib/editor/extensions/table/TableWrapperComponent.svelte';

let host: HTMLDivElement | null = null;
let component: Record<string, unknown> | null = null;

afterEach(async () => {
	if (component) await unmount(component);
	component = null;
	host?.remove();
	host = null;
	flushSync();
});

function tableWrapper(): PMNode {
	const table = createTableNode(schema, 2, 2, false, 'horizontal-lines');
	const caption = schema.nodes.table_caption.create(null, schema.text('A visible caption'));
	return schema.nodes.table_wrapper.create({ label: 'table-ui', captionPlacement: 'above' }, [caption, table]);
}

describe('table selection toolbar', () => {
	it('exposes caption, persistent-width, rule, and directional structure controls in place', () => {
		host = document.body.appendChild(document.createElement('div'));
		const setCaptionPlacement = vi.fn();
		const setColumnWidth = vi.fn();
		const setRowRule = vi.fn();
		const changeStructure = vi.fn();
		component = mount(TableWrapperComponent, {
			target: host,
			props: {
				dialect: 'latex',
				tableNumber: 1,
				sectionNumber: null,
				node: tableWrapper(),
				updateAttrs: vi.fn(),
				checkDuplicate: () => false,
				rowRules: ['', ''],
				bottomRule: '',
				setRowRule,
				setBottomRule: vi.fn(),
				setVerticalLines: vi.fn(),
				setColumnWidth,
				setCaptionPlacement,
				colspec: 'cc',
				tableEnv: 'tabular',
				setColspec: vi.fn(),
				tablePreset: null,
				canChangePreset: true,
				isSelected: true,
				applyPreset: vi.fn(),
				canChangeRows: true,
				canChangeColumns: true,
				canSetColumnWidths: true,
				changeStructure
			}
		});
		flushSync();

		const panel = host.querySelector('[aria-label="' + m.table_contextual_tools() + '"]');
		expect(panel).not.toBeNull();

		const captionSelect = host.querySelector<HTMLSelectElement>('select');
		expect(captionSelect).not.toBeNull();
		captionSelect!.value = 'below';
		captionSelect!.dispatchEvent(new Event('change', { bubbles: true }));
		expect(setCaptionPlacement).toHaveBeenCalledWith('below');

		const widthSlider = host.querySelector<HTMLInputElement>('input[type="range"]');
		expect(widthSlider).not.toBeNull();
		widthSlider!.value = '37';
		widthSlider!.dispatchEvent(new Event('input', { bubbles: true }));
		widthSlider!.dispatchEvent(new Event('change', { bubbles: true }));
		expect(setColumnWidth).toHaveBeenCalledWith(0, 37);
		const widthInput = host.querySelector<HTMLInputElement>('input[type="number"]');
		expect(widthInput).not.toBeNull();
		widthInput!.value = '42';
		widthInput!.dispatchEvent(new Event('input', { bubbles: true }));
		widthInput!.dispatchEvent(new Event('change', { bubbles: true }));
		expect(setColumnWidth).toHaveBeenCalledWith(0, 42);

		const addRule = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === m.tablewrap_add_hline());
		expect(addRule).toBeDefined();
		addRule!.click();
		expect(setRowRule).toHaveBeenCalledWith(0, '\\hline');

		host.querySelector<HTMLButtonElement>('[aria-label="' + m.table_insert_column_left() + '"]')!.click();
		expect(changeStructure).toHaveBeenCalledWith('column-before');
	});
});
