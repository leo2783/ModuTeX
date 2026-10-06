import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { Mapping, StepMap } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { ImagePluginAction, ImagePluginSettings } from './types';
import { imagePluginKey } from './imagepluginutils';
import { currentDocMetaStore } from '$lib/stores/metaStore';
import { get } from 'svelte/store';
import { mount } from 'svelte';
import ImageOverlay from './ImageOverlay.svelte';
// the library no longer exports ToastSettings
type ToastSettings = { message: string; timeout?: number };

import { getStorageUrl, uploadImage } from '$lib/editor/request';
import { joinPath, isRemoteSrc } from '$lib/workspace/fileSystem';
import { editorFileUrl, editorWriteBinary } from '$lib/editor/fileAccess';
import imageNotFoundPng from '$lib/assets/compile/image_not_found_placeholder.png';

export const defaultDeleteSrc = () => Promise.resolve();

export const defaultExtraAttributes = {
	width: null,
	height: null,
	maxWidth: null
};

export const defaultCreateOverlay = () => {
	const container = document.createElement('div');
	container.className = 'image-overlay-container absolute inset-0 pointer-events-none';
	container.setAttribute('contenteditable', 'false');
	return container;
};

// stashed on the overlay element so update calls can find the mounted component's props
// without a separate WeakMap registry
interface OverlayHost extends HTMLElement {
	__svelteComponentProps?: { node: PMNode; view: EditorView; getPos: () => number | undefined };
}

export const defaultUpdateOverlay = (overlay: Node, getPos: () => number | undefined, view: EditorView, node: PMNode) => {
	if (overlay instanceof HTMLElement) {
		const overlayHost = overlay as OverlayHost;
		const existingProps = overlayHost.__svelteComponentProps;

		if (existingProps) {
			existingProps.node = node;
			existingProps.view = view;
			existingProps.getPos = getPos;
		} else {
			const componentProps = $state({
				node,
				view,
				getPos
			});

			mount(ImageOverlay, {
				target: overlay,
				props: componentProps
			});

			overlayHost.__svelteComponentProps = componentProps;
		}
	}
};

export const defaultResizeCallback = (el: Element, updateCallback: () => void) => {
	const observer = new ResizeObserver(() => updateCallback());
	observer.observe(el);
	return () => {
		observer.unobserve(el);
	};
};

export const defaultCreateDecorations = (state: EditorState) => imagePluginKey.getState(state) || DecorationSet.empty;

const defaultFindPlaceholder = (state: EditorState, id: object) => {
	const decos = imagePluginKey.getState(state);
	const found = decos?.find(undefined, undefined, (spec) => spec.id === id);
	return found?.length ? found[0].from : undefined;
};

const defaultCreateState = () => ({
	init() {
		return DecorationSet.empty;
	},
	apply(tr: Transaction, value: DecorationSet, oldState: EditorState): DecorationSet {
		const diffStart = tr.doc.content.findDiffStart(oldState.doc.content);
		const diffEnd = oldState.doc.content.findDiffEnd(tr.doc.content);
		const map = diffEnd && diffStart ? new StepMap([diffStart, diffEnd.a - diffStart, diffEnd.b - diffStart]) : new StepMap([0, 0, 0]);

		const pmMapping = new Mapping([map]);
		let set = value.map(pmMapping, tr.doc);

		const action: ImagePluginAction = tr.getMeta(imagePluginKey);
		if (action?.type === 'add') {
			const widget = document.createElement('placeholder');
			const deco = Decoration.widget(action.pos, widget, {
				id: action.id
			});
			set = set.add(tr.doc, [deco]);
		} else if (action?.type === 'remove') {
			set = set.remove(set.find(undefined, undefined, (spec) => spec.id === action.id));
		}
		return set;
	}
});

// templates only get example content, never user images
const TEMPLATE_PLACEHOLDER_IMAGE = 'public/texpile/example_images/example_gradient_blue.png';

/** image settings for template editor mode: static placeholder, no uploads. */
export const createTemplateEditorSettings = (): ImagePluginSettings => {
	const uploadFile = async (_file: File): Promise<string> => {
		return TEMPLATE_PLACEHOLDER_IMAGE;
	};

	const deleteSrc = async (_filePath: string) => {
		return;
	};

	// offline build: no remote storage, use the bundled placeholder
	const downloadImage = async (_src: string): Promise<string> => {
		return imageNotFoundPng;
	};

	return {
		uploadFile,
		hasTitle: true,
		deleteSrc,
		extraAttributes: defaultExtraAttributes,
		createOverlay: defaultCreateOverlay,
		updateOverlay: defaultUpdateOverlay,
		defaultTitle: 'Image title',
		defaultAlt: 'Image',
		enableResize: true,
		isBlock: true,
		resizeCallback: defaultResizeCallback,
		imageMargin: 15,
		minSize: 50,
		maxSize: 2000,
		scaleImage: true,
		createState: defaultCreateState,
		createDecorations: defaultCreateDecorations,
		findPlaceholder: defaultFindPlaceholder,
		downloadImage
	} as ImagePluginSettings;
};

export const createDefaultSettings = (firebaseUid: string): ImagePluginSettings => {
	const defaultUploadFile = (file: File): Promise<string> =>
		new Promise((resolve, reject) => {
			console.log('Uploading image:', file.name, 'size:', file.size, 'type:', file.type);
			if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
				const t: ToastSettings = {
					message: 'Only PNG and JPEG images are allowed. Please upload the correct file type.',
					timeout: 3000
				};
				dispatchEvent(new CustomEvent('toast', { detail: t }));
				reject(new Error('Only PNG and JPEG images are allowed. Please upload the correct file type.'));
				return;
			}

			if (file.size > 1.5 * 1024 * 1024) {
				const t: ToastSettings = {
					message: 'File size exceeds 1.5 MB. Please resize your image and try again.',
					timeout: 3000
				};
				dispatchEvent(new CustomEvent('toast', { detail: t }));
				reject(new Error('File size exceeds 1.5 MB. Please resize your image and try again.'));
				return;
			}

			const docId = get(currentDocMetaStore).docref;
			const fileExtension = file.name.split('.').pop();
			const imageId = crypto.randomUUID() + '-' + Date.now();
			const sanitizedFileName = `${imageId}.${fileExtension}`;

			const filePath = `users/${firebaseUid}/documents/${docId}/images/${sanitizedFileName}`;
			console.log('Uploading image to path:', filePath);
			uploadImage(filePath, file)
				.then(() => {
					resolve(filePath);
				})
				.catch((error) => {
					reject(error);
				});
		});

	const deleteSrc = async (_filePath: string) => {
		return;
	};

	const downloadImage = async (src: string): Promise<string> => {
		console.log('Downloading image from src:', src);
		// offline build: images resolve to local paths/URLs via getStorageUrl below

		const retries = 3;
		const delayInterval = 1000;

		const filePath = src;

		const attemptDownload = (attempt: number): Promise<string> => {
			return getStorageUrl(filePath)
				.then((url) => url)
				.catch(async (error) => {
					console.log(error);
					if (attempt < retries - 1) {
						return new Promise((resolve) => {
							setTimeout(() => resolve(attemptDownload(attempt + 1)), delayInterval);
						});
					} else {
						const t = {
							message: 'Error downloading image',
							timeout: 3000
						};
						dispatchEvent(new CustomEvent('toast', { detail: t }));
						// fall back to the bundled image-not-found placeholder
						return imageNotFoundPng;
					}
				});
		};

		return attemptDownload(0);
	};

	return {
		uploadFile: defaultUploadFile,
		hasTitle: true,
		deleteSrc,
		extraAttributes: defaultExtraAttributes,
		createOverlay: defaultCreateOverlay,
		updateOverlay: defaultUpdateOverlay,
		defaultTitle: 'Image title',
		defaultAlt: 'Image',
		enableResize: true,
		isBlock: true,
		resizeCallback: defaultResizeCallback,
		imageMargin: 15,
		minSize: 50,
		maxSize: 2000,
		scaleImage: true,
		createState: defaultCreateState,
		createDecorations: defaultCreateDecorations,
		findPlaceholder: defaultFindPlaceholder,
		downloadImage
	} as ImagePluginSettings;
};

const LOCAL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

async function uploadLocalImage(file: File, imageDir: string): Promise<string> {
	if (!LOCAL_IMAGE_TYPES.includes(file.type)) {
		dispatchEvent(new CustomEvent('toast', { detail: { message: 'Only PNG, JPEG, GIF and WebP images are supported.', timeout: 3000 } }));
		throw new Error('Unsupported image type');
	}
	const ext = (file.name.split('.').pop() || 'png').toLowerCase();
	// short but collision-resistant filename, e.g. images/pasted-image-a1b2c3d4.png
	const shortId = crypto.randomUUID().split('-')[0];
	const name = `pasted-image-${shortId}.${ext}`;
	const abs = joinPath(joinPath(imageDir, 'images'), name);
	await editorWriteBinary(abs, file);
	// tell the workspace the folder changed so the file-tree sidebar re-scans
	dispatchEvent(new CustomEvent('texpile:fs-changed'));
	// the node stores the on-disk-relative path the .tex needs; downloadImage resolves it for display
	return `images/${name}`;
}

// shown in place of any http(s) image src. The app promises no network, and the packaged CSP
// already refuses the fetch (img-src carries no https:) — this makes the policy visible instead
// of a broken-image icon, and closes the dev-server build, which has no CSP and would fetch.
// Display-only: attrs.src keeps the original URL, so serialization round-trips exactly.
const REMOTE_IMAGE_BLOCKED =
	'data:image/svg+xml;utf8,' +
	encodeURIComponent(
		// flat empty-state card: subtle translucent fill, lucide's image-off glyph (verbatim path
		// data, so it matches the app's icon set) + quiet label. Vector, so it scales; the muted
		// grays read on light and dark backgrounds alike.
		'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120" viewBox="0 0 480 120">' +
			'<rect width="480" height="120" fill="#80808018" rx="8"/>' +
			'<g transform="translate(222,24) scale(1.5)" stroke="#8a8a8a" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
			'<line x1="2" x2="22" y1="2" y2="22"/>' +
			'<path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/>' +
			'<line x1="13.5" x2="6" y1="13.5" y2="21"/>' +
			'<line x1="18" x2="21" y1="12" y2="15"/>' +
			'<path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/>' +
			'<path d="M21 15V5a2 2 0 0 0-2-2H9"/>' +
			'</g>' +
			'<text x="240" y="98" text-anchor="middle" font-family="system-ui" font-size="14" fill="#8a8a8a">Remote image blocked</text>' +
			'</svg>'
	);

/** image settings for the local folder editor: images land in images/ next to the document. */
export const createLocalImageSettings = (imageDir: string): ImagePluginSettings => {
	const base = createDefaultSettings('local');
	return {
		...base,
		uploadFile: (file: File) => uploadLocalImage(file, imageDir),
		// resolve the relative path to a served URL; pass through already-resolved LOCAL srcs
		downloadImage: async (src: string) => {
			if (/^https?:/i.test(src)) return REMOTE_IMAGE_BLOCKED;
			if (!src || isRemoteSrc(src) || /^(data:|blob:|file:)/.test(src)) return src;
			return editorFileUrl(joinPath(imageDir, src));
		},
		deleteSrc: async () => {}
	};
};
