<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Note from '$lib/docs/Note.svelte';
</script>

<DocsHead
	title={'Installation on Windows'}
	description={'Instructions for the planned ModuTeX 0.1.0 Windows release; no downloadable package is available yet.'}
	path="/docs/installation/windows"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Windows'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'Version 0.1.0 is planned as an npm package for Windows x64, but its GitHub Release has not been published. The EXE installer and code signing are planned for 0.1.1.'}
	</p>
</header>

<div class="mt-10 space-y-10">
	<Section
		title={'1. Run ModuTeX'}
		body={'After the 0.1.0 GitHub Release is published, install Node.js 24.19.0 with npm 11.17.0, download the attached .tgz and checksum, verify the SHA-256, then run the package. No release tarball or checksum is available yet. npx caches the package but does not install a permanent command.'}
	>
		<pre class="border-surface-200 bg-surface-50 text-surface-800 overflow-x-auto rounded-lg border p-4 font-mono text-sm"><code
				>npx --yes --package .\modutex-desktop-0.1.0.tgz -- modutex</code
			></pre>
		<div class="mt-4">
			<Note
				body={'This is the post-release command, not a currently downloadable package. Do not run it until the release assets and their SHA-256 receipt are published.'}
			/>
		</div>
	</Section>

	<p class="text-surface-600 text-sm">
		<a href="https://github.com/leo2783/latex/blob/main/docs/INSTALLATION.md" target="_blank" rel="noopener noreferrer" class="anchor">
			{'Repository installation guide (docs/INSTALLATION.md)'}
		</a>
	</p>

	<Section
		title={'2. Install a TeX distribution'}
		body={'Download `install-tl-windows.exe` from CTAN and run it. It unpacks itself, then starts the installer proper; an Advanced button exposes the scheme and directory options if you want a smaller install or a different location. When it finishes it adds the TeX Live binaries to your search path for you.'}
	>
		<div class="flex flex-wrap gap-x-6 gap-y-2">
			<a
				href="https://mirror.ctan.org/systems/texlive/tlnet/install-tl-windows.exe"
				class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
			>
				{'install-tl-windows.exe'}
				<ArrowRight class="h-4 w-4" />
			</a>
			<a
				href="https://www.tug.org/texlive/windows.html"
				target="_blank"
				rel="noopener noreferrer"
				class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
			>
				{'TeX Live on Windows'}
				<ArrowRight class="h-4 w-4" />
			</a>
		</div>
		<div class="mt-4 space-y-4">
			<Note
				body={'A full install is 7 GB or more and can take a long time. The Advanced screen lets you pick a smaller scheme, and TeX Live Manager adds packages later as documents need them.'}
			/>
			<Note body={'MiKTeX works just as well, but only one of the two can be active at a time: they share the same search path.'} />
		</div>
	</Section>

	<Section
		title={'3. Check it worked'}
		body={'The TeX installer edits the search path, so a Command Prompt that was already open will not see it until you close and reopen the terminal. Restart ModuTeX too, then check External programs in Preferences.'}
	>
		<a
			href="/docs/installation"
			class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
		>
			{'Checking the install'}
			<ArrowRight class="h-4 w-4" />
		</a>
	</Section>
</div>
