/** Await lazily-loaded viewer modules, then revalidate their component owner before setup. */
export async function runAfterCurrentPdfViewerLoad<T>(
	loadModules: () => Promise<T>,
	isCurrent: () => boolean,
	setupViewer: (modules: T) => void
): Promise<boolean> {
	const modules = await loadModules();
	if (!isCurrent()) return false;
	setupViewer(modules);
	return true;
}
