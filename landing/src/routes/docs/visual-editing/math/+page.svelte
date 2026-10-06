<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import Where from '$lib/docs/Where.svelte';
	import MenuPath from '$lib/docs/MenuPath.svelte';
	import Prose from '$lib/docs/Prose.svelte';
	import blockShot from '$lib/assets/showcase/app/math-block-settings.png';
	import numberedShot from '$lib/assets/showcase/app/math-numbered-toggle.png';
	import toolbarShot from '$lib/assets/showcase/app/math-toolbar.png';
	import menuShot from '$lib/assets/showcase/app/insert-math-menu.png';
	import alignShot from '$lib/assets/showcase/app/math-align-line-labels.png';

	const where = [
		{ label: 'Shortcut', value: 'Ctrl+M', note: 'Inline equation, flowing with the text.' },
		{ label: 'Shortcut', value: 'Ctrl+Shift+M', note: 'Display equation, on its own line.' },
		{ label: 'Menu', value: 'Insert › Math', note: 'Inline equation, Display equation, and every environment below, in one flat list.' }
	];
</script>

<DocsHead
	title={'Equations'}
	description={"Insert and edit equations in Texpile's visual editor: inline and display math, numbering and cross-references, the math toolbar, and LaTeX environments."}
	path="/docs/visual-editing/math"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Equations'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'Equations are edited as real math, not as text you hope compiles. Two shortcuts cover most of it; everything else is a click away.'}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<div class="mt-10 space-y-10">
	<Section
		title={'Numbering and references'}
		body={'Hover an equation for a Settings icon beside it, and switch on Numbered. Type @ anywhere in the document to reference it by number; renumbering after you add or remove equations is automatic.'}
	>
		<div class="grid gap-6 sm:grid-cols-2">
			<Figure src={blockShot} alt={'An equation block selected, with its Settings icon and a delete button'} />
			<Figure src={numberedShot} alt={"The Numbered toggle in an equation's settings"} />
		</div>
	</Section>

	<Section
		title={'The math toolbar'}
		body={'Click into any equation and a toolbar appears above it: symbols grouped by kind (Greek, calculus, relations, sets, matrices), inserted at the cursor. A Select equation block button selects the whole equation as one unit.'}
	>
		<Figure src={toolbarShot} alt={'The math toolbar: Common, Greek, Calculus, Relations, Sets, Trig, Matrix, Science, and Envs'} />
	</Section>

	<Section title={'Environments'} body={'You can insert math environments via Insert › Math.'}>
		<MenuPath path="Insert › Math" />
		<Figure src={menuShot} alt={'The Insert Math menu, listing equation types and environments'} narrow />
	</Section>

	<Section
		title={'Labels and numbered equations'}
		body={"Switch on Numbered in an equation's settings to add a label. Which kind of label you get depends on the environment."}
	>
		<div class="space-y-4">
			<div>
				<h3 class="text-surface-800 text-sm font-semibold">{'Single equations'}</h3>
				<p class="text-surface-600 mt-1 leading-relaxed">
					<Prose
						text={"A plain equation gets one label. Find it under the settings' Advanced options as `\\label`, the same one a `\\ref` points to, and edit it there."}
					/>
				</p>
			</div>
			<div>
				<h3 class="text-surface-800 text-sm font-semibold">{'Align, Gather, Alignat, and Eqnarray'}</h3>
				<p class="text-surface-600 mt-1 leading-relaxed">
					<Prose
						text={'These get a label per line instead. Open the settings and fill in the Line Labels field for each line, or click Auto to generate one. Lines are split on `\\\\` in your LaTeX.'}
					/>
				</p>
			</div>
			<div>
				<h3 class="text-surface-800 text-sm font-semibold">{'Multline'}</h3>
				<p class="text-surface-600 mt-1 leading-relaxed">
					{'Multline keeps a single label, not one per line, since it still renders as one block.'}
				</p>
			</div>
		</div>
		<Figure src={alignShot} alt={"An Align equation's settings, showing per-line labels for line 1 and line 2"} narrow />
	</Section>
</div>
