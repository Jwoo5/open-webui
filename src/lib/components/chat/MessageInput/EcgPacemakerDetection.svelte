<script lang="ts">
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	const i18n = getContext<Writable<i18nType>>('i18n');

	// Whether the analysis of the recording being attached runs pacemaker
	// detection. Every place the dialog asks it shows one instance at a time,
	// so the hint's id is the same in each.
	export let checked = false;
	export let disabled = false;

	const hintId = 'ecg-pacemaker-detection-hint';
</script>

<div class="min-w-0" class:opacity-50={disabled}>
	<label
		class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200"
		class:cursor-pointer={!disabled}
	>
		<input type="checkbox" class="size-3.5" bind:checked {disabled} aria-describedby={hintId} />
		{$i18n.t('Pacemaker detection')}
	</label>

	<div id={hintId} class="text-xs text-gray-400 dark:text-gray-500 mt-1.5">
		{$i18n.t(
			'Off by default, since detection can mistake other sharp deflections for pacing spikes. Turn it on if you know the patient has a pacemaker.'
		)}
	</div>
</div>
