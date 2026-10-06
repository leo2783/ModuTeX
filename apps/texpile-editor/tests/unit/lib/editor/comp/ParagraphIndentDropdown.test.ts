// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ParagraphIndentDropdown from '../../../../../src/lib/editor/comp/toolbar/ParagraphIndentDropdown.svelte';

let host: HTMLDivElement;
let app: Record<string, unknown> | null = null;

function option(label: string) {
	return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((button) => button.textContent?.trim() === label);
}

afterEach(async () => {
	if (app) await unmount(app);
	await Promise.resolve();
	flushSync();
	app = null;
	host?.remove();
});

describe('ParagraphIndentDropdown', () => {
	it('exposes labelled three-state direct selection with keyboard navigation and Escape', async () => {
		host = document.body.appendChild(document.createElement('div'));
		const onSelect = vi.fn<(indent: 'auto' | 'indent' | 'noindent') => void>();
		app = mount(ParagraphIndentDropdown, { target: host, props: { value: 'auto', onSelect } });
		flushSync();

		const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Paragraph indent"]')!;
		expect(trigger.disabled).toBe(false);
		expect(trigger.textContent).toContain('Auto');
		trigger.focus();
		trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
		await Promise.resolve();
		flushSync();

		expect(option('Auto')?.getAttribute('aria-checked')).toBe('true');
		expect(document.activeElement).toBe(option('Auto'));
		const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
		option('Auto')!.dispatchEvent(down);
		await Promise.resolve();
		expect(document.activeElement).toBe(option('Indent'));
		option('Indent')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
		expect(onSelect).toHaveBeenCalledWith('indent');

		trigger.click();
		flushSync();
		option('No indent')!.focus();
		option('No indent')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await Promise.resolve();
		expect(document.activeElement).toBe(trigger);
	});

	it('is unavailable outside a paragraph instead of accepting a no-op selection', () => {
		host = document.body.appendChild(document.createElement('div'));
		app = mount(ParagraphIndentDropdown, { target: host, props: { value: 'auto', onSelect: vi.fn(), disabled: true } });
		flushSync();
		const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Paragraph indent"]')!;
		expect(trigger.disabled).toBe(true);
		expect(trigger.title).toBe('Paragraph indent is available in a paragraph');
	});
});
