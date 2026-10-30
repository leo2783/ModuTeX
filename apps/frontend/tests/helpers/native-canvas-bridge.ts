// SPDX-License-Identifier: Apache-2.0

export type NativeCanvasSurface = {
	width: number;
	height: number;
	getContext(type: '2d'): CanvasRenderingContext2D;
};

export type NativeCanvasFactory = {
	createCanvas(width: number, height: number): NativeCanvasSurface;
};

type CanvasWindow = {
	HTMLCanvasElement: typeof HTMLCanvasElement;
};

/** Bridge JSDOM canvas elements to native raster surfaces for PDF tests. */
export function installNativeCanvasBridge(
	win: CanvasWindow,
	nativeCanvas: NativeCanvasFactory
): { nativeSurfaceFor(canvas: HTMLCanvasElement): NativeCanvasSurface } {
	const surfaces = new WeakMap<
		HTMLCanvasElement,
		{ width: number; height: number; surface: NativeCanvasSurface }
	>();
	const drawImageMethods = new WeakMap<object, (...args: unknown[]) => void>();

	function nativeSurfaceFor(canvas: HTMLCanvasElement): NativeCanvasSurface {
		const width = canvas.width;
		const height = canvas.height;
		const current = surfaces.get(canvas);
		if (current && current.width === width && current.height === height) return current.surface;

		// @napi-rs/canvas treats a zero-sized createCanvas request as its default
		// size. Keep the DOM dimensions separately and use a tiny inert backing
		// surface until the DOM canvas has drawable dimensions again.
		const surface = nativeCanvas.createCanvas(Math.max(1, width), Math.max(1, height));
		surfaces.set(canvas, { width, height, surface });
		return surface;
	}

	function nativeContextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
		const context = nativeSurfaceFor(canvas).getContext('2d');
		if (!drawImageMethods.has(context)) {
			const nativeDrawImage = context.drawImage.bind(context) as unknown as (...args: unknown[]) => void;
			drawImageMethods.set(context, nativeDrawImage);
			context.drawImage = ((source: CanvasImageSource, ...args: number[]) => {
				// A DOM canvas may have been resized after the caller obtained this
				// context. Resolve both the destination and any canvas source again
				// so drawImage uses their current native surfaces.
				const destinationContext = nativeContextFor(canvas);
				const destinationDrawImage = drawImageMethods.get(destinationContext);
				if (!destinationDrawImage) throw new Error('NATIVE_CANVAS_DRAW_IMAGE_UNAVAILABLE');
				const input = source instanceof win.HTMLCanvasElement
					? nativeSurfaceFor(source as HTMLCanvasElement)
					: source;
				destinationDrawImage(input, ...args);
			}) as typeof context.drawImage;
		}
		return context;
	}

	Object.defineProperty(win.HTMLCanvasElement.prototype, 'getContext', {
		configurable: true,
		value: function (this: HTMLCanvasElement, kind: string) {
			if (kind !== '2d') return null;
			return nativeContextFor(this);
		}
	});

	return { nativeSurfaceFor };
}
