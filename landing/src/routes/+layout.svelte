<script lang="ts">
	import Footer from '$lib/comp/Footer.svelte';
	import Navbar from '$lib/comp/Navbar.svelte';
	import MachineTranslationBanner from '$lib/comp/MachineTranslationBanner.svelte';
	import '../app.css';

	let { children } = $props();
</script>

<!-- min-h-screen flex column so short pages (404) still pin the footer to the viewport bottom -->
<div class="flex min-h-screen flex-col">
	<MachineTranslationBanner />
	<Navbar />
	<main class="flex flex-1 flex-col">
		{@render children()}
	</main>
	<Footer />
</div>
