// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import LinkTooltip from '../../../../src/lib/editor/extensions/link/LinkTooltip.svelte';

let component: ReturnType<typeof mount> | undefined;
let host: HTMLDivElement;
const animateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');

beforeEach(() => {
	// Only the missing jsdom animation primitive is supplied; the real component and navigation run.
	Object.defineProperty(Element.prototype, 'animate', {
		configurable: true,
		value: () => ({ cancel() {}, onfinish: null, currentTime: 0, playState: 'finished', effect: null })
	});
});

afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	host?.remove();
	vi.restoreAllMocks();
	if (animateDescriptor) Object.defineProperty(Element.prototype, 'animate', animateDescriptor);
	else Reflect.deleteProperty(Element.prototype, 'animate');
});

function render(href: string, onOpen?: (href: string) => boolean) {
	host = document.body.appendChild(document.createElement('div'));
	component = mount(LinkTooltip, {
		target: host,
		props: {
			href,
			title: null,
			linkText: href,
			position: { x: 10, y: 10 },
			onOpen,
			onUpdate: vi.fn(),
			onRemove: vi.fn(),
			onClose: vi.fn()
		}
	});
	flushSync();
	return host.querySelector<HTMLAnchorElement>('a')!;
}

it('routes workspace link text through the local interceptor without browser navigation', () => {
	const onOpen = vi.fn(() => true);
	const link = render('chapters/intro.md#overview', onOpen);
	const event = new MouseEvent('click', { bubbles: true, cancelable: true });
	link.dispatchEvent(event);
	expect(onOpen).toHaveBeenCalledExactlyOnceWith('chapters/intro.md#overview');
	expect(event.defaultPrevented).toBe(true);
});

it.each([false, undefined])('keeps external link text native when interceptor is %s', (intercept) => {
	const href = 'https://example.invalid/docs';
	const onOpen = intercept === undefined ? undefined : vi.fn(() => intercept);
	const link = render(href, onOpen);
	const event = new MouseEvent('click', { bubbles: true, cancelable: true });
	link.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(false);
	expect(link.getAttribute('href')).toBe(href);
	expect(link.target).toBe('_blank');
	expect(link.rel.split(' ')).toEqual(expect.arrayContaining(['external', 'noopener', 'noreferrer']));
	if (onOpen) expect(onOpen).toHaveBeenCalledExactlyOnceWith(href);
});

it.each([true, false])('keeps explicit Open action interception and safe browser fallback (%s)', (intercept) => {
	const href = intercept ? 'chapters/intro.md' : 'https://example.invalid/docs';
	const onOpen = vi.fn(() => intercept);
	render(href, onOpen);
	const open = vi.spyOn(window, 'open').mockReturnValue(null);
	const buttons = host.querySelectorAll<HTMLButtonElement>('button');
	buttons[1].click();
	expect(onOpen).toHaveBeenCalledExactlyOnceWith(href);
	if (intercept) expect(open).not.toHaveBeenCalled();
	else expect(open).toHaveBeenCalledExactlyOnceWith(href, '_blank', 'noopener,noreferrer');
});
