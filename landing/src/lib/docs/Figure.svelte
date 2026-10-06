<script lang="ts">
	// One of `src` (image) or `mp4`/`webm` (muted looping demo, behaves like an animated image).
	// `narrow` is for the homepage feature thumbs, which are ~500px wide and go blurry if they are
	// stretched to the full content column.
	let {
		src,
		mp4,
		webm,
		alt,
		caption,
		narrow = false
	}: { src?: string; mp4?: string; webm?: string; alt: string; caption?: string; narrow?: boolean } = $props();
</script>

<figure class="my-6">
	<div class="border-surface-200 overflow-hidden rounded-xl border shadow-lg {narrow ? 'mx-auto max-w-xl' : ''}">
		{#if src}
			<img {src} {alt} loading="lazy" draggable="false" class="block w-full" />
		{:else}
			<video autoplay muted loop playsinline disablepictureinpicture aria-label={alt} class="block w-full">
				{#if webm}<source src={webm} type="video/webm" />{/if}
				{#if mp4}<source src={mp4} type="video/mp4" />{/if}
			</video>
		{/if}
	</div>
	{#if caption}
		<figcaption class="text-surface-500 mt-2 text-center text-sm">{caption}</figcaption>
	{/if}
</figure>
