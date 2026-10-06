<script lang="ts">
	// the hero product shot: one file, two views. Sits back small and tilted, then zooms up to full
	// size and flat as you scroll. Both shots must be the SAME document at the SAME scroll position
	// or the crossfade stops reading as a mode switch and starts reading as two unrelated screenshots.
	import { onMount } from 'svelte';
	import { Eye, Code } from '@lucide/svelte';
	import visual from '$lib/assets/showcase/editor-visual.webp';
	import source from '$lib/assets/showcase/editor-source.webp';
	import { m } from '$lib/paraglide/messages';

	const shots = [
		{ icon: Eye, label: m.showcase_toggle_visual(), src: visual, caption: m.showcase_shot_visual() },
		{ icon: Code, label: m.showcase_toggle_source(), src: source, caption: m.showcase_shot_source() }
	];

	const DEMO_FLIP_AFTER = 2600;

	// finish the zoom well before the hero clears the viewport, so there's still hero left to look at
	const revealOver = () => Math.min(340, Math.max(220, window.innerHeight * 0.42));

	let active = $state(0);
	let touched = $state(false);
	let frame = $state<HTMLDivElement | null>(null);

	function pick(i: number) {
		touched = true;
		active = i;
	}

	onMount(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

		// no transition on the transform, so these writes land as state rather than as an animation
		const apply = () => frame?.style.setProperty('--reveal', Math.min(window.scrollY / revealOver(), 1).toFixed(3));

		let raf = 0;
		const onScroll = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				apply();
			});
		};
		apply();
		window.addEventListener('scroll', onScroll, { passive: true });

		// one unprompted flip so the control reads as interactive, then it's user driven forever
		const demo = setTimeout(() => {
			if (!touched) active = 1;
		}, DEMO_FLIP_AFTER);

		return () => {
			window.removeEventListener('scroll', onScroll);
			cancelAnimationFrame(raf);
			clearTimeout(demo);
		};
	});
</script>

<div class="mx-auto w-full max-w-full px-4 sm:px-6 lg:max-w-[min(1400px,78vw)] lg:px-8">
	<div class="mb-6 flex justify-center">
		<div class="border-surface-200 inline-flex items-center gap-1 rounded-lg border bg-white p-1">
			{#each shots as shot, i (shot.label)}
				{@const Icon = shot.icon}
				<button
					onclick={() => pick(i)}
					aria-pressed={i === active}
					aria-label={m.showcase_toggle_aria({ label: shot.label })}
					class="rounded-base flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors {i === active
						? 'bg-primary-500 text-white'
						: 'text-surface-600 hover:text-surface-900'}"
				>
					<Icon class="h-4 w-4" />
					{shot.label}
				</button>
			{/each}
		</div>
	</div>

	<div class="stage">
		<div bind:this={frame} class="frame border-surface-200 overflow-hidden rounded-lg border">
			<div class="grid">
				{#each shots as shot, i (shot.label)}
					<img
						src={shot.src}
						alt={shot.caption}
						loading="eager"
						draggable="false"
						class="col-start-1 row-start-1 block h-auto w-full transition-opacity duration-500 {i === active
							? 'opacity-100'
							: 'pointer-events-none opacity-0'}"
					/>
				{/each}
			</div>
		</div>
	</div>

	<p class="text-surface-800 mt-5 text-center text-sm" aria-live="polite">{shots[active].caption}</p>
</div>

<style>
	.stage {
		perspective: 1600px;
	}

	.frame {
		--reveal: 1;
		transform-origin: 50% 20%;
		transform: rotateX(calc((1 - var(--reveal)) * 18deg)) scale(calc(0.86 + var(--reveal) * 0.14));
		box-shadow: 0 30px 80px -24px rgb(11 41 73 / 0.35);
		will-change: transform;
	}

	/* also the no-JS state: the custom property default above leaves it flat, full size, readable */
	@media (prefers-reduced-motion: reduce) {
		.frame {
			--reveal: 1 !important;
		}
	}
</style>
