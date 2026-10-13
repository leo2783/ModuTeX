import { imagePath } from './store.ts';

export const IMAGE_CLIPBOARD = 'application/x-modutex-image';
export function clipboardImage(event: ClipboardEvent): Blob | null {
	const file = [...(event.clipboardData?.files ?? [])].find(file => /^image\/(png|jpeg)$/.test(file.type));
	if (file) return file;
	const encoded = event.clipboardData?.getData(IMAGE_CLIPBOARD);
	if (!encoded) return null;
	if (encoded.length > 7 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE');
	const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
	return new Blob([bytes]);
}

export function imageCell(host: HTMLElement, initialSource: string, read: (path: string) => Promise<Blob>, select: () => void, text: (zh: string, en: string) => string) {
	const button = host.ownerDocument.createElement('button'); button.type = 'button'; button.className = 'visual-image-content'; button.setAttribute('aria-label', text('圖片', 'Image'));
	host.className = 'visual-image'; host.append(button);
	let source = initialSource, blob: Blob | null = null, bytes: Uint8Array | null = null, url: string | null = null, generation = 0;
	let clipboardPNG: Promise<Blob> | null = null;
	async function render() {
		const ticket = ++generation; blob = null; bytes = null; clipboardPNG = null;
		if (url) URL.revokeObjectURL(url); url = null;
		const path = imagePath(source); if (!path) return;
		button.textContent = text('載入圖片…', 'Loading image…');
		try {
			const loaded = await read(path), data = new Uint8Array(await loaded.arrayBuffer());
			if (ticket !== generation) return;
			blob = loaded; bytes = data; url = URL.createObjectURL(loaded);
			const image = host.ownerDocument.createElement('img'); image.src = url; image.alt = path;
			button.replaceChildren(image);
		} catch { if (ticket === generation) button.textContent = text('找不到圖片：', 'Image unavailable: ') + path; }
	}
	button.addEventListener('click', () => { select(); button.focus(); });
	const copy = (event: ClipboardEvent): boolean => {
		if (!bytes || !blob || !event.clipboardData) return false;
		event.preventDefault(); event.stopPropagation();
		let binary = ''; for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
		event.clipboardData.setData(IMAGE_CLIPBOARD, btoa(binary)); event.clipboardData.setData('text/plain', source);
		// PNG is the cross-application clipboard format. Internal copies keep the
		// original bytes above, including JPEG, without any conversion.
		if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
			const copiedBlob = blob;
			clipboardPNG ??= copiedBlob.type === 'image/png' ? Promise.resolve(copiedBlob) : (async () => {
				const bitmap = await createImageBitmap(copiedBlob);
				try { const canvas = host.ownerDocument.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d')!.drawImage(bitmap, 0, 0); return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('IMAGE_CLIPBOARD')), 'image/png')); }
				finally { bitmap.close(); }
			})();
			void navigator.clipboard.write([new ClipboardItem({ 'image/png': clipboardPNG })]).catch(() => {});
		}
		return true;
	};
	button.addEventListener('copy', copy);
	void render();
	return { copy, update(next: string) { if (source !== next) { source = next; void render(); } }, dispose() { generation++; if (url) URL.revokeObjectURL(url); } };
}
