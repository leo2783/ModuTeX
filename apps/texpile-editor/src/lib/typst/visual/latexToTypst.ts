// LaTeX -> Typst via MathLive's OWN serializer (getValue('typst'), the engine behind its
// "Copy as Typst"). Reached only for equations the user actually EDITED in a mathfield - which
// guarantees MathLive is loaded, since the mathfield is how the edit happened. Unedited
// equations never come here: the serializer re-emits their original typst attr byte-for-byte.
interface MathfieldLike {
	setValue(v: string, opts?: { silenceNotifications?: boolean }): void;
	getValue(format: string): string;
	style: CSSStyleDeclaration;
}

let mf: MathfieldLike | null = null;

export function latexToTypst(latex: string): string | null {
	if (typeof window === 'undefined' || typeof document === 'undefined') return null;
	const MF = (window as unknown as { MathfieldElement?: new () => MathfieldLike & HTMLElement }).MathfieldElement;
	if (!MF) return null; // mathlive never loaded => nothing was edited through it
	try {
		if (!mf) {
			const el = new MF();
			// parked offscreen: getValue needs a constructed element, not a visible one
			el.style.position = 'fixed';
			el.style.left = '-99999px';
			el.style.width = '0';
			el.style.height = '0';
			document.body.appendChild(el);
			mf = el;
		}
		mf.setValue(latex, { silenceNotifications: true });
		const out = mf.getValue('typst');
		return typeof out === 'string' && out.trim() ? out.trim() : null;
	} catch {
		return null;
	}
}
