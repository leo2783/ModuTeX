// SPDX-License-Identifier: Apache-2.0
// Strictly bind a signed PE to the exact CI-tested image. This is byte
// equivalence, not an Authenticode digest or a cryptographic trust check.
// The native signature verifier separately checks trust, publisher, timestamp,
// and product metadata.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PE_SIGNATURE = Buffer.from([0x50, 0x45, 0x00, 0x00]);
const MAX_SECTIONS = 96;
const SECURITY_DIRECTORY_INDEX = 4;

function fail(label, message) {
	throw new Error(`${label}: ${message}`);
}

function requireRange(bytes, offset, length, label, field) {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length < 0 ||
		offset > bytes.length ||
		length > bytes.length - offset
	) {
		fail(label, `${field} is outside the PE image`);
	}
}

function readU16(bytes, offset, label, field) {
	requireRange(bytes, offset, 2, label, field);
	return bytes.readUInt16LE(offset);
}

function readU32(bytes, offset, label, field) {
	requireRange(bytes, offset, 4, label, field);
	return bytes.readUInt32LE(offset);
}

function align8(value) {
	const aligned = Math.ceil(value / 8) * 8;
	if (!Number.isSafeInteger(aligned)) throw new Error('PE alignment overflow');
	return aligned;
}

function validateCertificateTable(bytes, offset, size, label) {
	const end = offset + size;
	let cursor = offset;
	let records = 0;

	while (cursor < end) {
		const remaining = end - cursor;
		if (remaining < 8) fail(label, 'Truncated WIN_CERTIFICATE header');
		const length = readU32(bytes, cursor, label, 'WIN_CERTIFICATE length');
		if (length <= 8) fail(label, 'WIN_CERTIFICATE has no certificate payload');
		if (length > remaining) fail(label, 'WIN_CERTIFICATE length exceeds the certificate table');

		const revision = readU16(bytes, cursor + 4, label, 'WIN_CERTIFICATE revision');
		const type = readU16(bytes, cursor + 6, label, 'WIN_CERTIFICATE type');
		if (revision !== 0x0100 && revision !== 0x0200) {
			fail(label, 'Unsupported WIN_CERTIFICATE revision');
		}
		if (type !== 0x0002) fail(label, 'Certificate table is not PKCS signed data');

		const paddedLength = align8(length);
		if (paddedLength > remaining) {
			if (length !== remaining) fail(label, 'Truncated WIN_CERTIFICATE alignment padding');
			cursor = end;
		} else {
			for (let index = length; index < paddedLength; index++) {
				if (bytes[cursor + index] !== 0) {
					fail(label, 'WIN_CERTIFICATE alignment padding is not zero');
				}
			}
			cursor += paddedLength;
		}
		records++;
	}

	if (records === 0) fail(label, 'Certificate table is empty');
}

function parsePeImage(bytes, label) {
	if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
		fail(label, 'Missing DOS header');
	}

	const peHeaderOffset = readU32(bytes, 0x3c, label, 'DOS e_lfanew');
	if (peHeaderOffset < 0x40) fail(label, 'NT header overlaps the DOS header');
	requireRange(bytes, peHeaderOffset, 24, label, 'NT headers');
	if (!bytes.subarray(peHeaderOffset, peHeaderOffset + 4).equals(PE_SIGNATURE)) {
		fail(label, 'Missing PE signature');
	}

	const coffOffset = peHeaderOffset + 4;
	const sectionCount = readU16(bytes, coffOffset + 2, label, 'COFF section count');
	if (sectionCount === 0 || sectionCount > MAX_SECTIONS) {
		fail(label, 'Invalid COFF section count');
	}
	const optionalHeaderSize = readU16(bytes, coffOffset + 16, label, 'Optional header size');
	const optionalHeaderOffset = coffOffset + 20;
	requireRange(bytes, optionalHeaderOffset, optionalHeaderSize, label, 'Optional header');

	const optionalMagic = readU16(bytes, optionalHeaderOffset, label, 'Optional header magic');
	let directoryOffset;
	let numberOfDirectoriesOffset;
	if (optionalMagic === 0x010b) {
		directoryOffset = 96;
		numberOfDirectoriesOffset = 92;
	} else if (optionalMagic === 0x020b) {
		directoryOffset = 112;
		numberOfDirectoriesOffset = 108;
	} else {
		fail(label, 'Unsupported PE optional header magic');
	}
	if (optionalHeaderSize < directoryOffset + (SECURITY_DIRECTORY_INDEX + 1) * 8) {
		fail(label, 'Optional header omits the security directory');
	}
	const numberOfDirectories = readU32(
		bytes,
		optionalHeaderOffset + numberOfDirectoriesOffset,
		label,
		'NumberOfRvaAndSizes'
	);
	const availableDirectories = Math.floor((optionalHeaderSize - directoryOffset) / 8);
	if (numberOfDirectories <= SECURITY_DIRECTORY_INDEX || numberOfDirectories > availableDirectories) {
		fail(label, 'Invalid optional-header data-directory count');
	}

	const checksumOffset = optionalHeaderOffset + 64;
	requireRange(bytes, checksumOffset, 4, label, 'PE checksum');
	const securityDirectoryOffset =
		optionalHeaderOffset + directoryOffset + SECURITY_DIRECTORY_INDEX * 8;
	const certificateOffset = readU32(bytes, securityDirectoryOffset, label, 'Certificate file offset');
	const certificateSize = readU32(bytes, securityDirectoryOffset + 4, label, 'Certificate table size');
	if ((certificateOffset === 0) !== (certificateSize === 0)) {
		fail(label, 'Certificate file offset and size must both be zero or both be nonzero');
	}

	const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
	const sectionTableSize = sectionCount * 40;
	requireRange(bytes, sectionTableOffset, sectionTableSize, label, 'Section table');
	const sectionTableEnd = sectionTableOffset + sectionTableSize;
	const sizeOfHeaders = readU32(bytes, optionalHeaderOffset + 60, label, 'SizeOfHeaders');
	if (sizeOfHeaders < sectionTableEnd || sizeOfHeaders > bytes.length) {
		fail(label, 'Invalid PE headers size or truncated section table');
	}

	let certificateEnd = 0;
	if (certificateSize !== 0) {
		if (certificateOffset % 8 !== 0) fail(label, 'Certificate table is not 8-byte aligned');
		if (certificateOffset < sizeOfHeaders) fail(label, 'Certificate table overlaps PE headers');
		requireRange(bytes, certificateOffset, certificateSize, label, 'Certificate table');
		certificateEnd = certificateOffset + certificateSize;
		if (certificateEnd !== bytes.length) {
			fail(label, 'Certificate table must end exactly at the end of the PE file');
		}
		validateCertificateTable(bytes, certificateOffset, certificateSize, label);
	}

	const rawRanges = [];
	for (let index = 0; index < sectionCount; index++) {
		const headerOffset = sectionTableOffset + index * 40;
		const rawSize = readU32(bytes, headerOffset + 16, label, `Section ${index} raw size`);
		const rawOffset = readU32(bytes, headerOffset + 20, label, `Section ${index} raw offset`);
		if (rawSize === 0) continue;
		if (rawOffset < sizeOfHeaders) fail(label, `Section ${index} raw data overlaps PE headers`);
		requireRange(bytes, rawOffset, rawSize, label, `Section ${index} raw data`);
		const rawEnd = rawOffset + rawSize;
		if (certificateSize !== 0 && rawOffset < certificateEnd && certificateOffset < rawEnd) {
			fail(label, `Section ${index} overlaps the certificate table`);
		}
		rawRanges.push({ start: rawOffset, end: rawEnd, index });
	}
	rawRanges.sort((left, right) => left.start - right.start);
	for (let index = 1; index < rawRanges.length; index++) {
		if (rawRanges[index].start < rawRanges[index - 1].end) {
			fail(label, `Sections ${rawRanges[index - 1].index} and ${rawRanges[index].index} overlap`);
		}
	}

	return {
		peHeaderOffset,
		optionalHeaderOffset,
		optionalHeaderSize,
		optionalMagic,
		sectionCount,
		sectionTableOffset,
		checksumOffset,
		securityDirectoryOffset,
		certificateOffset,
		certificateSize
	};
}

function asBuffer(value, label) {
	if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be a Uint8Array`);
	return Buffer.from(value);
}

export function verifyTestedToSignedPeContent(testedImage, signedImage) {
	const testedBytes = asBuffer(testedImage, 'Tested image');
	const signedBytes = asBuffer(signedImage, 'Signed image');
	const tested = parsePeImage(testedBytes, 'Tested image');
	const signed = parsePeImage(signedBytes, 'Signed image');

	if (tested.certificateSize !== 0) throw new Error('Tested image already has a certificate table');
	if (signed.certificateSize === 0) throw new Error('Signed image has no Authenticode certificate table');

	for (const field of [
		'peHeaderOffset',
		'optionalHeaderOffset',
		'optionalHeaderSize',
		'optionalMagic',
		'sectionCount',
		'sectionTableOffset',
		'checksumOffset',
		'securityDirectoryOffset'
	]) {
		if (tested[field] !== signed[field]) throw new Error(`PE layout changed while signing: ${field}`);
	}

	const expectedCertificateOffset = align8(testedBytes.length);
	if (signed.certificateOffset !== expectedCertificateOffset) {
		throw new Error('Certificate table is not immediately appended after the tested image');
	}
	const alignmentPadding = expectedCertificateOffset - testedBytes.length;
	if (alignmentPadding < 0 || alignmentPadding > 7) {
		throw new Error('Invalid signer-added alignment padding length');
	}
	for (let offset = testedBytes.length; offset < expectedCertificateOffset; offset++) {
		if (signedBytes[offset] !== 0) {
			throw new Error('Signer-added alignment padding before the certificate table must be zero');
		}
	}

	for (let offset = 0; offset < testedBytes.length; offset++) {
		const isChecksum = offset >= tested.checksumOffset && offset < tested.checksumOffset + 4;
		const isSecurityDirectory =
			offset >= tested.securityDirectoryOffset && offset < tested.securityDirectoryOffset + 8;
		if (isChecksum || isSecurityDirectory) continue;
		if (testedBytes[offset] !== signedBytes[offset]) {
			throw new Error(`PE image bytes differ at file offset 0x${offset.toString(16)}`);
		}
	}

	return Object.freeze({
		testedImageBytes: testedBytes.length,
		certificateOffset: signed.certificateOffset,
		certificateSize: signed.certificateSize,
		alignmentPadding
	});
}

async function main() {
	if (process.argv.length !== 4) {
		throw new Error('Usage: node verify-authenticode-image.mjs <tested-unsigned.exe> <signed.exe>');
	}
	const testedBytes = await readFile(process.argv[2]);
	const signedBytes = await readFile(process.argv[3]);
	const result = verifyTestedToSignedPeContent(testedBytes, signedBytes);
	console.log(
		`Strict tested-to-signed PE content identity verified: all tested bytes, including overlay bytes, match except the PE checksum and security-directory entry; certificate table is structurally bounded and ${result.alignmentPadding} zero alignment bytes were added.`
	);
	console.log('Cryptographic trust, publisher, timestamp, and product metadata must be verified separately.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main().catch((error) => {
		console.error(`PE content identity verification failed: ${error.message}`);
		process.exitCode = 1;
	});
}
