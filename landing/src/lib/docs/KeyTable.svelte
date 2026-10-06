<script lang="ts">
	// Windows/Linux combos, since that is what most visitors are on. The macOS equivalents are in the
	// app's own shortcuts window (Ctrl -> Cmd), so we don't duplicate the whole table here.

	let { rows }: { rows: { keys: string; label: string }[] } = $props();
</script>

<div class="border-surface-200 overflow-x-auto rounded-lg border">
	<table class="w-full text-left text-sm">
		<tbody class="divide-surface-200 divide-y">
			{#each rows as row (row.label)}
				<tr>
					<td class="text-surface-700 w-40 px-4 py-2.5 whitespace-nowrap">
						{#each row.keys.split(' ') as key (key)}
							<kbd class="border-surface-300 bg-surface-50 text-surface-700 rounded-base mr-1 border px-1.5 py-0.5 font-mono text-xs"
								>{key}</kbd
							>
						{/each}
					</td>
					<td class="text-surface-600 px-4 py-2.5">{row.label}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
<p class="text-surface-500 mt-2 text-sm">{'On macOS, use Cmd wherever this table says Ctrl.'}</p>
