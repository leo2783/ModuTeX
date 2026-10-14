import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument } from '@modutex/document-core';
import { imageSource, imagePath, referencedImages } from '../../src/features/images/store.ts';

test('managed image source round trips and file references ignore comments and literal code', () => {
	const path = 'modutex-image-abcd.png', image = imageSource(path);
	assert.equal(imagePath(image), path);
	assert.throws(() => imageSource('../outside.png'));
	assert.throws(() => imageSource('evil}\\input{secret}.png'));
	const source = '\\documentclass{article}\n\\begin{document}\n% \\includegraphics{modutex-image-dead.png}\n\\begin{verbatim}\n\\includegraphics{modutex-image-dead.png}\n\\end{verbatim}\n' + image + image + '\\end{document}\n';
	assert.deepEqual(referencedImages(SourceDocument.open(new TextEncoder().encode(source))), [path]);
});
