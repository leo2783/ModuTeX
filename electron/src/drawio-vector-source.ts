import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { inflateRawSync } from 'node:zlib';
import { DRAWIO_SOURCE_LIMIT } from './diagram-security';

const INTERMEDIATE_LIMIT = 30 * 1024 * 1024;
function invalid(): never {
	throw new Error('INVALID_REQUEST');
}
function parse(xml: string): Document {
	if (!xml || Buffer.byteLength(xml, 'utf8') > DRAWIO_SOURCE_LIMIT || /<!|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)) invalid();
	try {
		return new DOMParser({ errorHandler: { warning: invalid, error: invalid, fatalError: invalid } }).parseFromString(xml, 'text/xml');
	} catch {
		invalid();
	}
}
/** Only a temporary copy. Every original page/id/label/geometry survives; no filesystem access. */
export function prepareDrawioVectorSource(xml: string): { xml: string } {
	if (typeof xml !== 'string' || xml.length > DRAWIO_SOURCE_LIMIT) invalid();
	const doc = parse(xml);
	const root = doc.documentElement;
	if (!root || !['mxfile', 'mxGraphModel'].includes(root.nodeName) || root.namespaceURI) invalid();
	for (let node = doc.firstChild; node; node = node.nextSibling) {
		if (
			node !== root &&
			!(node.nodeType === 3 && !node.nodeValue?.trim()) &&
			!(
				node.nodeType === 7 &&
				node.nodeName === 'xml' &&
				/^version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*$/i.test(node.nodeValue ?? '')
			)
		)
			invalid();
	}
	let decodedBytes = 0,
		intermediateBytes = 0;
	if (root.nodeName === 'mxfile') {
		let pages = 0;
		for (let page = root.firstChild; page; page = page.nextSibling) {
			if (page.nodeType === 3 && !page.nodeValue?.trim()) continue;
			if (page.nodeType !== 1 || page.nodeName !== 'diagram' || ++pages > 100) invalid();
			const diagram = page as Element;
			if (diagram.childNodes.length === 1 && diagram.firstChild?.nodeType === 3 && diagram.textContent?.trim()) {
				const text = diagram.textContent.trim();
				if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) invalid();
				let decoded: string;
				try {
					const binary = Buffer.from(text, 'base64');
					if (binary.toString('base64') !== text) invalid();
					const inflated = inflateRawSync(binary, { maxOutputLength: INTERMEDIATE_LIMIT - intermediateBytes });
					intermediateBytes += inflated.length;
					decoded = decodeURIComponent(new TextDecoder('utf-8', { fatal: true }).decode(inflated));
				} catch {
					invalid();
				}
				decodedBytes += Buffer.byteLength(decoded, 'utf8');
				if (decodedBytes > DRAWIO_SOURCE_LIMIT) invalid();
				const model = parse(decoded).documentElement;
				if (!model || model.nodeName !== 'mxGraphModel') invalid();
				diagram.removeChild(diagram.firstChild!);
				diagram.appendChild(doc.importNode(model, true));
			}
			const models: Element[] = [];
			for (let child = diagram.firstChild; child; child = child.nextSibling) {
				if (child.nodeType === 3 && !child.nodeValue?.trim()) continue;
				if (child.nodeType !== 1 || child.nodeName !== 'mxGraphModel') invalid();
				models.push(child as Element);
			}
			if (models.length !== 1) invalid();
		}
		if (!pages) invalid();
	}
	const pending: { node: Node; depth: number }[] = [{ node: root, depth: 1 }];
	let nodes = 0;
	while (pending.length) {
		const { node, depth } = pending.pop()!;
		if (++nodes > 20_000 || depth > 64) invalid();
		if (node.nodeType !== 1 && node.nodeType !== 3) invalid();
		if (node.nodeType === 1) {
			const element = node as Element;
			if (element.namespaceURI || element.nodeName.includes(':')) invalid();
			for (let i = 0; i < element.attributes.length; i++)
				if (element.attributes[i].namespaceURI || element.attributes[i].name.includes(':')) invalid();
			if (element.nodeName === 'mxCell') {
				const style = (element.getAttribute('style') ?? '').split(';').filter((part) => part && part.split('=', 1)[0] !== 'convertToSvg');
				element.setAttribute('style', [...style, 'convertToSvg=1', ''].join(';'));
			}
		}
		for (let child = node.lastChild; child; child = child.previousSibling) pending.push({ node: child, depth: depth + 1 });
	}
	const result = new XMLSerializer().serializeToString(root, false, undefined, { requireWellFormed: true });
	if (Buffer.byteLength(result, 'utf8') > DRAWIO_SOURCE_LIMIT) invalid();
	return { xml: result };
}
