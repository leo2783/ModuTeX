/** The editing dialect a shared extension serves. Dialect-aware extensions/chrome accept this
 * at init and derive their own feature flags internally (the initExtension('latex') convention),
 * so per-feature booleans don't multiply across call sites. Behavior hooks that need workspace
 * wiring (opening files, jumping) stay callbacks — a dialect string can't perform them — and
 * per-node concerns (raw island language) stay on node attrs, which is finer-grained. */
export type Dialect = 'latex' | 'markdown' | 'typst';
