export type SplitterBounds = Readonly<{ min: number; max: number }>;
export type SplitterAxis = 'vertical' | 'horizontal';

export function clampSplitterValue(value: number, bounds: SplitterBounds): number {
	const min = Number.isFinite(bounds.min) ? bounds.min : 0;
	const max = Number.isFinite(bounds.max) ? Math.max(min, bounds.max) : min;
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

export function splitterBounds(
	containerSize: number,
	minBefore: number,
	minAfter: number,
	separatorSize = 8
): SplitterBounds {
	const usableSize = Number.isFinite(containerSize) ? containerSize : 0;
	const divider = Number.isFinite(separatorSize) ? Math.max(0, separatorSize) : 0;
	const usable = Math.max(0, usableSize - divider);
	const before = Number.isFinite(minBefore) ? Math.max(0, minBefore) : 0;
	const after = Number.isFinite(minAfter) ? Math.max(0, minAfter) : 0;
	if (before + after > usable) {
		const midpoint = usable / 2;
		return { min: midpoint, max: midpoint };
	}
	return { min: before, max: usable - after };
}

export function splitterKeyboardValue(
	key: string,
	axis: SplitterAxis,
	value: number,
	bounds: SplitterBounds,
	step = 16
): number | null {
	if (key === 'Home') return bounds.min;
	if (key === 'End') return bounds.max;
	if (axis === 'vertical') {
		if (key === 'ArrowLeft') return clampSplitterValue(value - step, bounds);
		if (key === 'ArrowRight') return clampSplitterValue(value + step, bounds);
	} else {
		if (key === 'ArrowUp') return clampSplitterValue(value - step, bounds);
		if (key === 'ArrowDown') return clampSplitterValue(value + step, bounds);
	}
	return null;
}
