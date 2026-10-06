import { TextSelection } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import imageNotFoundPng from '$lib/assets/compile/image_not_found_placeholder.png';
import { imagePluginClassNames, type ImagePluginSettings } from '../types';
import createResizeControls from './resize/createResizeControls';
import getImageDimensions from './resize/getImageDimensions';
import getMaxWidth from './resize/getMaxWidth';
import calculateImageDimensions from './resize/calculateImageDimensions';
import { imageDisplaySource, revisionedPreviewUrl, type ImageDisplaySource } from './diagram-image-preview';

const PRESENTATION_ATTRS = new Set(['width', 'height', 'maxWidth', 'options']);

const matchesMountedNode = (expectedNode: Node, currentNode: Node | null | undefined): boolean => {
	if (!currentNode || expectedNode.type.name !== 'image' || currentNode.type !== expectedNode.type || !currentNode.eq(expectedNode)) {
		return false;
	}
	const expectedDisplay = imageDisplaySource(expectedNode.attrs);
	const currentDisplay = imageDisplaySource(currentNode.attrs);
	if (expectedDisplay.path !== currentDisplay.path || expectedDisplay.diagramPreview !== currentDisplay.diagramPreview) return false;
	if (!expectedDisplay.diagramPreview) return true;
	return (
		expectedNode.attrs.diagramType === 'drawio' &&
		currentNode.attrs.diagramType === 'drawio' &&
		expectedNode.attrs.diagramId === currentNode.attrs.diagramId &&
		expectedNode.attrs.diagramSource === currentNode.attrs.diagramSource &&
		expectedNode.attrs.src === currentNode.attrs.src
	);
};

const getSrc = (
	image: HTMLImageElement,
	pluginSettings: ImagePluginSettings,
	node: Node,
	root: Element,
	view: EditorView,
	displayPath: string
): { newSrc: Promise<string>; appliedClass?: string } => {
	if (pluginSettings.downloadImage) {
		let appliedClass;
		if (pluginSettings.downloadPlaceholder) {
			if (pluginSettings.enableResize && node.attrs.width && node.attrs.height) {
				const maxWidth = getMaxWidth(root, pluginSettings);
				const finalDimensions = calculateImageDimensions(
					maxWidth,
					maxWidth,
					node.attrs.width,
					node.attrs.height,
					pluginSettings,
					node.attrs.width,
					node.attrs.height
				);

				image.style.height = `${finalDimensions.height}px`;

				image.style.width = `${finalDimensions.width}px`;
			}
			const placeholder = pluginSettings.downloadPlaceholder(displayPath, view);
			if (typeof placeholder === 'string') {
				image.src = placeholder;
			} else if (typeof placeholder === 'object') {
				if ('src' in placeholder && typeof placeholder.src === 'string') {
					image.src = placeholder.src;
				}
				if ('className' in placeholder && typeof placeholder.className === 'string') {
					appliedClass = placeholder.className;

					image.className = `${image.className} ${appliedClass}`;
				}
			}
		}
		return {
			newSrc: pluginSettings.downloadImage(displayPath),
			appliedClass
		};
	}
	return { newSrc: Promise.resolve(displayPath) };
};

const imageNodeView =
	(pluginSettings: ImagePluginSettings) =>
	(node: Node, view: EditorView, getPos: () => number | undefined): NodeView => {
		let currentNode = node;
		let currentDisplay = imageDisplaySource(node.attrs);
		let dimensions: { width: number; height: number; completed: boolean } | undefined;
		let resizeActive = false;
		let destroyed = false;
		let loadPending = false;
		let loadGeneration = 0;
		let previewRevision = 0;
		let notFound = false;
		let unsubscribeResizeObserver: (() => void) | undefined;
		let resizeControls: HTMLDivElement | undefined;
		let activeImageRequest: { node: Node; display: ImageDisplaySource; generation: number; url: string } | undefined;

		const root = document.createElement('div');
		root.className = imagePluginClassNames.imagePluginRoot;
		const image = document.createElement('img');
		image.className = imagePluginClassNames.imagePluginImg;
		image.contentEditable = 'false';
		root.appendChild(image);

		const isMounted = (expectedNode: Node): boolean => {
			if (destroyed || view.isDestroyed) return false;
			try {
				const pos = getPos();
				return pos !== undefined && matchesMountedNode(expectedNode, view.state.doc.nodeAt(pos));
			} catch {
				return false;
			}
		};
		const isCurrent = (expectedNode: Node, generation: number): boolean =>
			generation === loadGeneration && currentNode === expectedNode && isMounted(expectedNode);

		const setResizeActive = (value: boolean) => {
			resizeActive = value;
		};

		const showNotFound = (expectedNode: Node, display: ImageDisplaySource, generation: number) => {
			if (!isCurrent(expectedNode, generation) || image.src === imageNotFoundPng) return;
			notFound = true;
			image.src = imageNotFoundPng;
			image.classList.add('image-not-found');
			image.title = display.diagramPreview
				? `Diagram SVG preview unavailable: ${display.path}`
				: `File not found: ${expectedNode.attrs.src}`;
		};

		image.addEventListener('error', () => {
			const request = activeImageRequest;
			if (!request || image.getAttribute('src') !== request.url) return;
			showNotFound(request.node, request.display, request.generation);
		});

		const revalidate = async () => {
			const request = activeImageRequest;
			if (!request || /^(data:|blob:)/i.test(request.url)) return;
			try {
				const res = await fetch(request.url, { method: 'HEAD', cache: 'no-store' });
				if (!isCurrent(request.node, request.generation) || activeImageRequest !== request) return;
				if (!res.ok) return showNotFound(request.node, request.display, request.generation);
				if (notFound) {
					notFound = false;
					image.classList.remove('image-not-found');
					image.title = request.node.attrs.alt ?? '';
					const refreshedUrl = request.display.diagramPreview
						? revisionedPreviewUrl(request.url, ++previewRevision)
						: `${request.url}${request.url.includes('?') ? '&' : '?'}_=${Date.now()}`;
					request.url = refreshedUrl;
					image.src = refreshedUrl;
				}
			} catch {
				if (isCurrent(request.node, request.generation) && activeImageRequest === request) {
					showNotFound(request.node, request.display, request.generation);
				}
			}
		};
		const onFolderChanged = () => {
			if (currentDisplay.diagramPreview) startLoad(currentNode, currentDisplay);
			else void revalidate();
		};
		window.addEventListener('texpile:fs-changed', onFolderChanged);
		window.addEventListener('focus', onFolderChanged);

		Object.keys(node.attrs).forEach((key) => root.setAttribute(`imageplugin-${key}`, node.attrs[key]));
		const contentDOM = pluginSettings.hasTitle && document.createElement('div');
		if (contentDOM) {
			contentDOM.className = 'imagePluginContent';
			contentDOM.addEventListener('click', (e) => {
				const pos = getPos();
				if (pos === undefined || contentDOM.innerText.length > 1) {
					return;
				}
				e.preventDefault();
				view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1))));
				view.focus();
			});
			contentDOM.className = 'text';
			root.appendChild(contentDOM);
		}

		const overlay = pluginSettings.createOverlay(node, getPos, view);
		if (overlay) {
			root.appendChild(overlay);
			pluginSettings.updateOverlay(overlay, getPos, view, node);
		}

		image.alt = node.attrs.alt;
		const updateDOM = () => {
			const expectedNode = currentNode;
			const generation = loadGeneration;
			if (!isCurrent(expectedNode, generation) || resizeActive) return;

			const pos = getPos();
			if (pos === undefined || (pluginSettings.enableResize && !dimensions)) return;

			const updatedNode = view.state.doc.nodeAt(pos);
			if (!matchesMountedNode(expectedNode, updatedNode)) return;

			Object.keys(updatedNode.attrs).forEach((attr) => root.setAttribute(`imageplugin-${attr}`, updatedNode.attrs[attr]));
			image.alt = updatedNode.attrs.alt ?? '';

			if (pluginSettings.enableResize && dimensions) {
				const maxWidth = getMaxWidth(root, pluginSettings);
				const finalDimensions = calculateImageDimensions(
					maxWidth,
					maxWidth,
					dimensions.width,
					dimensions.height,
					pluginSettings,
					updatedNode.attrs.width,
					updatedNode.attrs.height,
					updatedNode.attrs.maxWidth
				);
				image.style.height = `${finalDimensions.height}px`;
				image.style.width = `${finalDimensions.width}px`;
				resizeControls?.remove();
				resizeControls = createResizeControls(
					finalDimensions.height,
					finalDimensions.width,
					getPos,
					updatedNode,
					view,
					image,
					setResizeActive,
					maxWidth,
					pluginSettings
				);
				root.appendChild(resizeControls);
			}
		};

		const startLoad = (targetNode: Node, display: ImageDisplaySource) => {
			const generation = ++loadGeneration;
			currentNode = targetNode;
			currentDisplay = display;
			loadPending = true;
			dimensions = undefined;
			activeImageRequest = undefined;
			void (async () => {
				try {
					const { newSrc, appliedClass } = getSrc(image, pluginSettings, targetNode, root, view, display.path);
					const resolvedSrc = await newSrc;
					if (!isCurrent(targetNode, generation)) return;
					const resolvedForDisplay = display.diagramPreview ? revisionedPreviewUrl(resolvedSrc, ++previewRevision) : resolvedSrc;
					const nextDimensions = pluginSettings.enableResize ? await getImageDimensions(resolvedForDisplay) : undefined;
					if (!isCurrent(targetNode, generation)) return;

					if (appliedClass) {
						image.className = image.className
							.split(' ')
							.filter((className: string) => className !== appliedClass)
							.join(' ');
					}
					loadPending = false;
					dimensions = nextDimensions;
					notFound = false;
					image.classList.remove('image-not-found');
					image.title = targetNode.attrs.alt ?? '';
					activeImageRequest = { node: targetNode, display, generation, url: resolvedForDisplay };
					image.src = resolvedForDisplay;
					updateDOM();
					const parent = root.parentElement;
					if (!parent || !pluginSettings.enableResize || unsubscribeResizeObserver) return;
					unsubscribeResizeObserver = pluginSettings.resizeCallback(parent, updateDOM);
				} catch {
					if (!isCurrent(targetNode, generation)) return;
					loadPending = false;
					showNotFound(targetNode, display, generation);
				}
			})();
		};

		startLoad(node, currentDisplay);
		return {
			...(contentDOM
				? {
						contentDOM,
						stopEvent: (e: Event) => e.target === contentDOM,
						selectable: true,
						content: 'text*'
					}
				: {}),
			dom: root,
			update: (updateNode: Node) => {
				if (updateNode.type.name !== 'image') return false;

				const previousNode = currentNode;
				const previousDisplay = currentDisplay;
				const nextDisplay = imageDisplaySource(updateNode.attrs);
				const changedAttrs = new Set(
					[...new Set([...Object.keys(previousNode.attrs), ...Object.keys(updateNode.attrs)])].filter(
						(key) => previousNode.attrs[key] !== updateNode.attrs[key]
					)
				);
				const presentationOnly =
					changedAttrs.size > 0 &&
					[...changedAttrs].every((key) => PRESENTATION_ATTRS.has(key)) &&
					previousNode.textContent === updateNode.textContent;
				const nodeReplaced = previousNode !== updateNode;
				const displayChanged = previousDisplay.path !== nextDisplay.path || previousDisplay.diagramPreview !== nextDisplay.diagramPreview;
				const sourceChanged = previousNode.attrs.src !== updateNode.attrs.src;
				const refreshPublishedDiagram = nextDisplay.diagramPreview && nodeReplaced && !presentationOnly;
				const refreshPendingNode = loadPending && nodeReplaced;
				const shouldLoad = displayChanged || sourceChanged || refreshPublishedDiagram || refreshPendingNode;

				currentNode = updateNode;
				currentDisplay = nextDisplay;
				image.alt = updateNode.attrs.alt ?? '';
				if (shouldLoad) {
					startLoad(updateNode, nextDisplay);
				} else if (activeImageRequest) {
					activeImageRequest = { ...activeImageRequest, node: updateNode, display: nextDisplay };
				}

				if (overlay) pluginSettings.updateOverlay(overlay, getPos, view, updateNode);
				updateDOM();
				return true;
			},
			ignoreMutation: () => true,
			destroy: () => {
				destroyed = true;
				loadGeneration++;
				activeImageRequest = undefined;
				unsubscribeResizeObserver?.();
				window.removeEventListener('texpile:fs-changed', onFolderChanged);
				window.removeEventListener('focus', onFolderChanged);
				pluginSettings.deleteSrc(node.attrs.src);
			}
		};
	};

export default imageNodeView;
