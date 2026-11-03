<script lang="ts">
	import { createEventDispatcher, getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { WEBUI_API_BASE_URL } from '$lib/constants';
	import { settings } from '$lib/stores';

	import Image from '$lib/components/common/Image.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import Heart from '$lib/components/icons/Heart.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';

	const i18n = getContext<Writable<i18nType>>('i18n');
	const dispatch = createEventDispatcher<{ remove: void }>();

	/** The item of the record's preview picture, or null when it has none. */
	export let preview: Record<string, unknown> | null = null;
	export let label = '';
	export let loading = false;
	/**
	 * Whether the record lacks an item the server needs to read it: the .hea
	 * of a sample, or the .dat or the .hea of a recording.
	 */
	export let incomplete = false;
	/** Whether the record's analysis runs pacemaker detection. */
	export let pacemakerDetection = false;
	/** Whether the chip offers to remove the record. */
	export let removable = true;
	/** The thumbnail of an image in the message input, or in a message being edited. */
	export let size: 'input' | 'edit' = 'input';

	// The address of the preview picture, or null while it has none yet: its
	// item gets one once the upload is done.
	const previewSrcOf = (item: Record<string, unknown> | null): string | null => {
		const url = typeof item?.url === 'string' ? item.url : '';
		if (url === '') {
			return null;
		}
		if (url.startsWith('data') || url.startsWith('http')) {
			return url;
		}
		return `${WEBUI_API_BASE_URL}/files/${url}${item?.content_type ? '/content' : ''}`;
	};

	$: src = previewSrcOf(preview);
	$: detail = [
		incomplete && !loading ? $i18n.t('Incomplete record') : $i18n.t('12-lead ECG'),
		...(pacemakerDetection ? [$i18n.t('Pacemaker detection on')] : [])
	].join(' · ');
	$: highContrast = $settings?.highContrastMode ?? false;
	$: thumbnailClass = size === 'edit' ? 'size-14' : 'size-10';
</script>

<div
	class="relative group flex max-w-60 items-center gap-2 rounded-xl pe-3 text-start bg-white dark:bg-gray-850 border border-gray-50/30 dark:border-gray-800/30"
	aria-busy={loading}
>
	<div class="relative shrink-0 {thumbnailClass}">
		{#if src !== null}
			<Image {src} alt={label} imageClassName="{thumbnailClass} rounded-xl object-cover" />
		{:else}
			<div
				class="{thumbnailClass} flex items-center justify-center rounded-xl bg-black/20 text-white dark:bg-white/10"
			>
				{#if loading}
					<Spinner className="size-4" />
				{:else}
					<Heart className="size-4.5" strokeWidth="1.5" />
				{/if}
			</div>
		{/if}
		{#if loading && src !== null}
			<div
				class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-black/40 text-white"
			>
				<Spinner className="size-4" />
			</div>
		{/if}
	</div>

	<Tooltip
		content={label}
		allowHTML={false}
		className="flex min-w-0 flex-1 flex-col justify-center"
		placement="top-start"
	>
		<div class="truncate text-sm font-normal dark:text-gray-100">{label}</div>
		<div
			class="truncate text-xs {highContrast ? 'text-gray-800 dark:text-gray-100' : 'text-gray-500'}"
		>
			{detail}
		</div>
	</Tooltip>

	{#if removable}
		<div class="absolute -top-1 -right-1">
			<button
				class="bg-white text-black border border-gray-50 rounded-full {highContrast
					? ''
					: 'hover-reveal transition'}"
				type="button"
				aria-label={$i18n.t('Remove ECG {{label}}', { label })}
				on:click|stopPropagation={() => dispatch('remove')}
			>
				<XMark className="size-4" />
			</button>
		</div>
	{/if}
</div>
