// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyTestedToSignedPeContent } from '../../scripts/distribution/verify-authenticode-image.mjs';

const PE_HEADER_OFFSET = 0x80;
const COFF_OFFSET = PE_HEADER_OFFSET + 4;
const OPTIONAL_HEADER_OFFSET = COFF_OFFSET + 20;
const OPTIONAL_HEADER_SIZE = 0xf0;
const SECTION_TABLE_OFFSET = OPTIONAL_HEADER_OFFSET + OPTIONAL_HEADER_SIZE;
const CHECKSUM_OFFSET = OPTIONAL_HEADER_OFFSET + 64;
const SECURITY_DIRECTORY_OFFSET = OPTIONAL_HEADER_OFFSET + 112 + 4 * 8;
const FILE_LENGTH_WITHOUT_OVERLAY = 0x600;

function makeTestedImage(overlay = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x55])) {
	const bytes = Buffer.alloc(FILE_LENGTH_WITHOUT_OVERLAY + overlay.length);
	bytes.write('MZ', 0, 'ascii');
	bytes.writeUInt32LE(PE_HEADER_OFFSET, 0x3c);
	bytes.write('PE\0\0', PE_HEADER_OFFSET, 'binary');
	bytes.writeUInt16LE(0x8664, COFF_OFFSET);
	bytes.writeUInt16LE(2, COFF_OFFSET + 2);
	bytes.writeUInt16LE(OPTIONAL_HEADER_SIZE, COFF_OFFSET + 16);

	bytes.writeUInt16LE(0x020b, OPTIONAL_HEADER_OFFSET);
	bytes.writeUInt32LE(0x1000, OPTIONAL_HEADER_OFFSET + 16);
	bytes.writeUInt32LE(0x1000, OPTIONAL_HEADER_OFFSET + 32);
	bytes.writeUInt32LE(0x200, OPTIONAL_HEADER_OFFSET + 36);
	bytes.writeUInt32LE(0x3000, OPTIONAL_HEADER_OFFSET + 56);
	bytes.writeUInt32LE(0x200, OPTIONAL_HEADER_OFFSET + 60);
	bytes.writeUInt32LE(0x12345678, CHECKSUM_OFFSET);
	bytes.writeUInt32LE(16, OPTIONAL_HEADER_OFFSET + 108);

	function writeSection(index, name, virtualAddress, rawOffset) {
		const header = SECTION_TABLE_OFFSET + index * 40;
		bytes.write(name, header, 'ascii');
		bytes.writeUInt32LE(0x180, header + 8);
		bytes.writeUInt32LE(virtualAddress, header + 12);
		bytes.writeUInt32LE(0x200, header + 16);
		bytes.writeUInt32LE(rawOffset, header + 20);
		bytes.writeUInt32LE(0x60000020, header + 36);
	}

	writeSection(0, '.text', 0x1000, 0x200);
	writeSection(1, '.rsrc', 0x2000, 0x400);
	bytes.fill(0x90, 0x200, 0x400);
	bytes.fill(0x42, 0x400, 0x600);
	overlay.copy(bytes, FILE_LENGTH_WITHOUT_OVERLAY);
	return bytes;
}

function align8(value) {
	return Math.ceil(value / 8) * 8;
}

function makeSignedImage(testedImage, extraPadding = 0) {
	assert.equal(extraPadding % 8, 0);
	const certificate = Buffer.from([0x30, 0x0b, 0x02, 0x01, 0x01, 0x04, 0x06, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
	const recordLength = 8 + certificate.length;
	const certificateSize = align8(recordLength);
	const certificateOffset = align8(testedImage.length) + extraPadding;
	const signed = Buffer.alloc(certificateOffset + certificateSize);
	testedImage.copy(signed);
	signed.writeUInt32LE(0x87654321, CHECKSUM_OFFSET);
	signed.writeUInt32LE(certificateOffset, SECURITY_DIRECTORY_OFFSET);
	signed.writeUInt32LE(certificateSize, SECURITY_DIRECTORY_OFFSET + 4);
	signed.writeUInt32LE(recordLength, certificateOffset);
	signed.writeUInt16LE(0x0200, certificateOffset + 4);
	signed.writeUInt16LE(0x0002, certificateOffset + 6);
	certificate.copy(signed, certificateOffset + 8);
	return signed;
}

test('accepts an unchanged tested image with a structurally valid appended signature table', () => {
	const tested = makeTestedImage();
	const signed = makeSignedImage(tested);
	const result = verifyTestedToSignedPeContent(tested, signed);
	assert.equal(result.testedImageBytes, tested.length);
	assert.equal(result.certificateOffset, align8(tested.length));
	assert.equal(result.alignmentPadding, 3);
});

for (const [label, offset] of [
	['code', 0x205],
	['resource', 0x405],
	['overlay', FILE_LENGTH_WITHOUT_OVERLAY + 2]
]) {
	test(`rejects a signed image with altered ${label} bytes`, () => {
		const tested = makeTestedImage();
		const altered = Buffer.from(tested);
		altered[offset] ^= 0xff;
		assert.throws(() => verifyTestedToSignedPeContent(tested, makeSignedImage(altered)), /PE image bytes differ at file offset/);
	});
}

test('rejects malformed section bounds and overlapping section data', () => {
	const outOfBounds = makeTestedImage();
	outOfBounds.writeUInt32LE(0x7fffffff, SECTION_TABLE_OFFSET + 16);
	assert.throws(
		() => verifyTestedToSignedPeContent(outOfBounds, makeSignedImage(outOfBounds)),
		/Section 0 raw data is outside the PE image/
	);

	const overlapping = makeTestedImage();
	overlapping.writeUInt32LE(0x300, SECTION_TABLE_OFFSET + 40 + 20);
	assert.throws(
		() => verifyTestedToSignedPeContent(overlapping, makeSignedImage(overlapping)),
		/Sections 0 and 1 overlap/
	);
});

test('rejects misaligned and out-of-bounds certificate offsets', () => {
	const tested = makeTestedImage();
	const misaligned = makeSignedImage(tested);
	misaligned.writeUInt32LE(align8(tested.length) + 1, SECURITY_DIRECTORY_OFFSET);
	assert.throws(() => verifyTestedToSignedPeContent(tested, misaligned), /not 8-byte aligned/);

	const outOfBounds = makeSignedImage(tested);
	outOfBounds.writeUInt32LE(0xfffffff8, SECURITY_DIRECTORY_OFFSET);
	assert.throws(() => verifyTestedToSignedPeContent(tested, outOfBounds), /Certificate table is outside the PE image/);
});

test('rejects malformed certificate lengths, directory sizes, and record padding', () => {
	const tested = makeTestedImage();
	const certificateOffset = align8(tested.length);
	const signed = makeSignedImage(tested);

	const invalidRecordLength = Buffer.from(signed);
	invalidRecordLength.writeUInt32LE(0xffffffff, certificateOffset);
	assert.throws(
		() => verifyTestedToSignedPeContent(tested, invalidRecordLength),
		/WIN_CERTIFICATE length exceeds the certificate table/
	);

	const invalidDirectorySize = Buffer.from(signed);
	const certificateSize = invalidDirectorySize.readUInt32LE(SECURITY_DIRECTORY_OFFSET + 4);
	invalidDirectorySize.writeUInt32LE(certificateSize - 1, SECURITY_DIRECTORY_OFFSET + 4);
	assert.throws(
		() => verifyTestedToSignedPeContent(tested, invalidDirectorySize),
		/Certificate table must end exactly at the end of the PE file/
	);

	const nonzeroRecordPadding = Buffer.from(signed);
	nonzeroRecordPadding[certificateOffset + certificateSize - 1] = 1;
	assert.throws(
		() => verifyTestedToSignedPeContent(tested, nonzeroRecordPadding),
		/WIN_CERTIFICATE alignment padding is not zero/
	);
});

test('allows only the required zero alignment bytes before the certificate table', () => {
	const tested = makeTestedImage();
	const nonzeroPadding = makeSignedImage(tested);
	nonzeroPadding[tested.length] = 1;
	assert.throws(
		() => verifyTestedToSignedPeContent(tested, nonzeroPadding),
		/Signer-added alignment padding before the certificate table must be zero/
	);

	const excessivePadding = makeSignedImage(tested, 8);
	assert.throws(
		() => verifyTestedToSignedPeContent(tested, excessivePadding),
		/not immediately appended/
	);
});

test('rejects bytes appended after the declared certificate table', () => {
	const tested = makeTestedImage();
	const signed = makeSignedImage(tested);
	const withTrailingBytes = Buffer.concat([signed, Buffer.from([0, 0, 0])]);
	assert.throws(
		() => verifyTestedToSignedPeContent(tested, withTrailingBytes),
		/Certificate table must end exactly at the end of the PE file/
	);
});
