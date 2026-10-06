<!-- editable \title/\author/\date fields for values that live in the preamble (the editor only
  renders the body); edits are redirected straight back into the preamble -->
<script lang="ts">
	import { extractPreambleFrontmatter, hasPreambleFrontmatterCommand } from '$lib/editor/extensions/raw-latex/frontmatterView';
	import { m } from '$lib/paraglide/messages';

	let {
		preamble = '',
		disabled = false,
		onEdit,
		onAddTitle
	}: {
		preamble?: string;
		disabled?: boolean;
		onEdit?: (kind: string, inner: string) => void;
		onAddTitle?: () => void;
	} = $props();

	const items = $derived(extractPreambleFrontmatter(preamble));
	const titleFieldExists = $derived(items.some((item) => item.kind === 'title'));
	const titleCommandExists = $derived(hasPreambleFrontmatterCommand(preamble, 'title'));
</script>

{#if !titleFieldExists && !titleCommandExists && onAddTitle}
	<div class="frontmatter-block">
		<button class="btn btn-xs hover:preset-tonal" type="button" {disabled} onclick={onAddTitle}>
			{m.preamble_add_title()}
		</button>
	</div>
{/if}
{#each items as item (item.kind)}
	<div class="frontmatter-block frontmatter-{item.kind}" contenteditable="false">
		{#if item.kind !== 'title'}
			<span class="frontmatter-label">{item.kind}</span>
		{/if}
		<input
			class="frontmatter-input"
			value={item.inner}
			placeholder={item.kind === 'title' ? m.preamble_title_placeholder() : item.kind}
			spellcheck="false"
			aria-label={item.kind}
			{disabled}
			oninput={(e) => onEdit?.(item.kind, (e.currentTarget as HTMLInputElement).value)}
		/>
	</div>
{/each}
