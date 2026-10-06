import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { prepareDrawioVectorSource } from '../src/drawio-vector-source';
const model =
	'<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="shape" value="中文&lt;br&gt;&lt;b&gt;bold&lt;/b&gt;" vertex="1" parent="1" style="html=1;convertToSvg=0;rounded=1;convertToSvg=0;"><mxGeometry x="10" y="20" width="100" height="60" as="geometry"/></mxCell></root></mxGraphModel>';
describe('temporary Draw.io vector copy', () => {
	it('preserves all compressed/uncompressed pages, ids, labels and geometry', () => {
		const compressed = deflateRawSync(encodeURIComponent(model)).toString('base64');
		const original = `<mxfile><diagram id="page-a" name="第一頁">${model}</diagram><diagram id="page-b" name="第二頁">${compressed}</diagram></mxfile>`;
		const result = prepareDrawioVectorSource(original).xml;
		expect(result).toContain('id="page-a"');
		expect(result).toContain('id="page-b"');
		expect(result.match(/<mxGraphModel>/g)).toHaveLength(2);
		expect(result.match(/convertToSvg=1/g)).toHaveLength(6);
		expect(result).not.toContain('convertToSvg=0');
		expect(result.match(/中文/g)).toHaveLength(2);
		expect(result).toContain('rounded=1;convertToSvg=1;');
		expect(result).toContain('width="100" height="60"');
		expect(original).toContain(compressed); // immutable original string remains saved-source input
	});
	it.each([
		'<!DOCTYPE mxfile><mxfile/>',
		'<mxfile/>',
		'<mxfile><diagram>!!!</diagram></mxfile>',
		'<mxGraphModel><root></mxGraphModel>',
		'<mxfile><diagram><mxGraphModel/><mxGraphModel/></diagram></mxfile>',
		'<mxGraphModel xmlns="http://evil.invalid"/>'
	])('rejects malformed/unsafe source', (xml) => {
		expect(() => prepareDrawioVectorSource(xml)).toThrow('INVALID_REQUEST');
	});
	it('bounds inflated intermediate bytes and decoded nodes', () => {
		const bomb = deflateRawSync('x'.repeat(30 * 1024 * 1024 + 1)).toString('base64');
		expect(() => prepareDrawioVectorSource(`<mxfile><diagram>${bomb}</diagram></mxfile>`)).toThrow('INVALID_REQUEST');
		expect(() => prepareDrawioVectorSource(`<mxGraphModel><root>${'<mxCell/>'.repeat(20_000)}</root></mxGraphModel>`)).toThrow(
			'INVALID_REQUEST'
		);
	});
});
