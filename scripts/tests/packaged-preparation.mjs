export const NPM_PREPARATION_TIMEOUT_MS = 600_000;
export const APPLICATION_START_TIMEOUT_MS = 45_000;

// npm's file fetcher extracts the entire large payload while reading its manifest.
// Keep this bounded preparation phase separate from application startup.
export async function waitForPackagePreparation(exit, {
  timeoutMs = NPM_PREPARATION_TIMEOUT_MS,
  progressIntervalMs = 30_000,
  onProgress = () => {}
} = {}) {
  const started = Date.now();
  const progress = setInterval(() => onProgress(Date.now() - started), progressIntervalMs);
  let deadline;
  try {
    return await Promise.race([
      exit,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('npm tarball preparation timed out')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(deadline);
    clearInterval(progress);
  }
}
