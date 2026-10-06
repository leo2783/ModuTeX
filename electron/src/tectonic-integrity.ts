import { createHash } from 'node:crypto';

export const TECTONIC_VERSION = '0.17.0';
export const TECTONIC_EXECUTABLE_SIZE = 51538432;
export const TECTONIC_EXECUTABLE_SHA256 = '99ffcfdbf1ebf8bdda9e791942e3d06aedb12463fddc33f07de6f5211c8bf08d';

/** Fixed reviewed policy; callers cannot substitute an executable policy. */
export function assertTectonicIntegrity(executable: Buffer, version: Buffer): void {
	if (!version.equals(Buffer.from(`${TECTONIC_VERSION}\n`))) throw new Error('INTEGRITY');
	if (executable.length !== TECTONIC_EXECUTABLE_SIZE) throw new Error('INTEGRITY');
	if (createHash('sha256').update(executable).digest('hex') !== TECTONIC_EXECUTABLE_SHA256) throw new Error('INTEGRITY');
	const pe = executable.readUInt32LE(0x3c);
	if (
		executable.toString('ascii', 0, 2) !== 'MZ' ||
		pe < 0x40 ||
		pe + 26 > executable.length ||
		executable.toString('binary', pe, pe + 4) !== 'PE\0\0' ||
		executable.readUInt16LE(pe + 4) !== 0x8664 ||
		executable.readUInt16LE(pe + 24) !== 0x020b
	)
		throw new Error('INTEGRITY');
}
