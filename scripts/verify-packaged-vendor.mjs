import { lstat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { verifyDrawioRuntimeResources } from './verify-vendor.mjs';
import { verifyPackagedTectonicResources } from './vendor/tectonic-vendor.mjs';
import { VendorVerificationError } from './vendor/vendor-artifact.mjs';

// Packaging uses reviewed runtime resources, never repository fixtures or archive caches.
export async function verifyPackagedVendorResources(resourcesRoot) {
	const root = resolve(resourcesRoot);
	for (const directory of [root, join(root, 'vendor')]) {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new VendorVerificationError('packaged vendor: resource root must be a regular directory');
		}
	}
	const entries = await readdir(join(root, 'vendor'), { withFileTypes: true });
	if (
		entries
			.map(({ name }) => name)
			.sort()
			.join('\n') !== 'drawio\nnotices\ntectonic' ||
		entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
	) {
		throw new VendorVerificationError('packaged vendor: exact runtime directory inventory required');
	}
	const drawio = await verifyDrawioRuntimeResources(root, { version: '31.1.8' });
	const tectonic = await verifyPackagedTectonicResources(root, 'modutex');
	return { drawio, tectonic };
}
