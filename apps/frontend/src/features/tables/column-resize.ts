/** Adjacent columns exchange width; other columns and the pair total stay unchanged. */
export function resizeColumns(weights: readonly number[], boundary: number, share: number): readonly number[] {
	if (weights.length < 2 || !Number.isInteger(boundary) || boundary < 0 || boundary >= weights.length - 1 ||
		!Number.isFinite(share) || weights.some(value => !Number.isFinite(value) || value <= 0 || value > 1000)) throw new Error('COLUMN_RESIZE');
	const total = weights.reduce((sum, value) => sum + value, 0);
	const pair = weights[boundary]! + weights[boundary + 1]!;
	// Preserve the generator's maximum weight while keeping both cells reachable.
	const floor = Math.min(pair * 0.05, weights[boundary]!, weights[boundary + 1]!);
	const minimum = Math.max(floor, pair - 1000);
	const maximum = Math.min(pair - floor, 1000);
	const left = Math.max(minimum, Math.min(maximum, weights[boundary]! + share * total));
	const right = pair - left;
	const next = [...weights];
	// Floating-point subtraction can round a very narrow positive column to zero.
	// Keep the original valid pair rather than make either adjacent column vanish.
	if (!Number.isFinite(left) || !Number.isFinite(right) || !(left > 0) || !(right > 0) || left > 1000 || right > 1000) {
		next[boundary] = weights[boundary]!; next[boundary + 1] = weights[boundary + 1]!;
	} else {
		next[boundary] = left; next[boundary + 1] = right;
	}
	return Object.freeze(next);
}

/** One captured pointer. Movement always uses the start snapshot, avoiding cumulative drift. */
export class ColumnDrag {
	private current: { pointer: number; x: number; width: number; boundary: number; weights: readonly number[] } | null = null;
	begin(pointer: number, x: number, width: number, boundary: number, weights: readonly number[]): boolean {
		if (this.current) return false;
		if (!Number.isSafeInteger(pointer) || !Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return false;
		resizeColumns(weights, boundary, 0);
		this.current = { pointer, x, width, boundary, weights: [...weights] }; return true;
	}
	move(pointer: number, x: number): readonly number[] | null {
		const current = this.current;
		if (!current || current.pointer !== pointer || !Number.isFinite(x)) return null;
		return resizeColumns(current.weights, current.boundary, (x - current.x) / current.width);
	}
	end(pointer: number): boolean {
		if (!this.current || this.current.pointer !== pointer) return false;
		this.current = null; return true;
	}
	cancel(): void { this.current = null; }
}
