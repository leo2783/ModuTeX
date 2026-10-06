<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';

	let { data }: { data: { verify: string } } = $props();
</script>

<DocsHead
	title={'Installation'}
	description={'Prepare for the planned ModuTeX 0.1.0 Windows x64 npm release; download assets are not available yet.'}
	path="/docs/installation"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Installation'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'ModuTeX 0.1.0 is planned as a Windows x64 npm package launched with npx. No release download is available yet. Install a TeX distribution only when you need to compile PDFs.'}
	</p>
</header>

<div class="border-surface-200 bg-primary-50 mt-8 rounded-lg border p-5">
	<p class="text-surface-700 leading-relaxed">
		{'The 0.1.0 GitHub Release, .tgz, and checksum have not been published yet. The EXE installer and code signing are planned for 0.1.1.'}
	</p>
	<a
		href="/docs/installation/windows"
		class="text-primary-600 hover:text-primary-700 mt-4 inline-flex items-center gap-1.5 font-medium transition-colors"
	>
		{'Windows installation'}
		<ArrowRight class="h-4 w-4" />
	</a>
	<a
		href="https://github.com/leo2783/latex/blob/main/docs/INSTALLATION.md"
		target="_blank"
		rel="noopener noreferrer"
		class="text-primary-600 hover:text-primary-700 mt-4 ml-5 inline-flex items-center gap-1.5 font-medium transition-colors"
	>
		{'Repository installation guide'}
		<ArrowRight class="h-4 w-4" />
	</a>
</div>

<div class="mt-12 space-y-10">
	<Section
		title={'Do I need LaTeX installed?'}
		body={'For editing, no. The visual editor, source editor, spell check, intellisense, and version control work on their own. The supported 0.1.0 compile path uses your installed TeX Live or MiKTeX. Bundled Tectonic files are not presented as the default compiler until the managed-runtime flow is complete.'}
	/>

	<Section
		title={'Check it worked'}
		body={'On Windows, this is the test. In a terminal, ask latexmk for its version. If that prints a version, ModuTeX will find it too:'}
	>
		{@html data.verify}
		<p class="text-surface-600 mt-6 leading-relaxed">
			{'Then open a folder in ModuTeX and press Compile. The default command is latexmk with lualatex, and anything that goes wrong is parsed out of the log into the Problems panel rather than left in the terminal.'}
		</p>
		<div class="mt-4 flex flex-wrap gap-x-6 gap-y-2">
			<a
				href="/docs/getting-started"
				class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
			>
				{'Getting started'}
				<ArrowRight class="h-4 w-4" />
			</a>
			<a
				href="/docs/compiling"
				class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
			>
				{'Compiling, in full'}
				<ArrowRight class="h-4 w-4" />
			</a>
		</div>
	</Section>
</div>
