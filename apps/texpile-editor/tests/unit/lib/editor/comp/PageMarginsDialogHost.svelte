<script lang="ts">
	import PageMarginsDialog from '$lib/editor/comp/PageMarginsDialog.svelte';
	import type { PageMarginsCoordinator } from '$lib/workspace/page-margins-context';

	let {
		coordinator,
		onClose
	}: {
		coordinator: PageMarginsCoordinator;
		onClose: () => void;
	} = $props();
	let open = $state(true);

	function closeDialog(): void {
		open = false;
		onClose();
	}
</script>

<PageMarginsDialog {open} {coordinator} onClose={closeDialog} />
