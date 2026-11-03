<script lang="ts">
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { settings } from '$lib/stores';

	import EcgImageViewer from './EcgImageViewer.svelte';

	const i18n = getContext<Writable<i18nType>>('i18n');

	/** The address of the record's preview picture. */
	export let src = '';
	/** The name the record is shown under. */
	export let label = '';
	/**
	 * Whether the record has the items the server needs to read it: the .hea
	 * of a sample, or both the .dat and the .hea of a recording.
	 */
	export let complete = true;
	/** Whether the record's analysis runs pacemaker detection. */
	export let pacemakerDetection = false;

	$: caption = [
		label,
		...(pacemakerDetection ? [$i18n.t('Pacemaker detection on')] : []),
		...(complete ? [] : [$i18n.t('Incomplete record')])
	].join(' · ');
</script>

<EcgImageViewer {src} alt={$i18n.t('ECG preview')} />
<div
	class="mt-1 px-0.5 truncate text-xs {($settings?.highContrastMode ?? false)
		? 'text-gray-800 dark:text-gray-100'
		: 'text-gray-500'}"
>
	{caption}
</div>
