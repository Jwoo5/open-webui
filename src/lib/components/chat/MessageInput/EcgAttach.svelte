<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { getContext, tick } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { WEBUI_BASE_URL } from '$lib/constants';
	import { config, models, settings, temporaryChatEnabled } from '$lib/stores';
	import type { Model } from '$lib/stores';
	import {
		CANONICAL_LEADS,
		isCanonicalLeadSet,
		isUsableRecordName,
		parseWfdbHeader,
		parseWfdbRecordHeader,
		readWfdbSignals,
		statedSignalCount
	} from '$lib/utils/wfdb';
	import type { WfdbHeader } from '$lib/utils/wfdb';
	import { fittingPxPerMm, renderEcgImage } from '$lib/utils/ecgImage';
	import {
		agentSamplesUrl,
		datasetNamedBy,
		fetchSampleRecord,
		loadSampleIndex,
		resolveSamplesBase,
		searchSamples
	} from '$lib/utils/ecgSamples';
	import type { EcgSample, EcgSampleIndex } from '$lib/utils/ecgSamples';
	import {
		ecgRecordOf,
		ecgSendBlocker,
		exceedsFileLimit,
		hasEcgAttachment,
		withoutEcgRecord
	} from '$lib/utils/ecgAttachments';
	import type { EcgSource } from '$lib/utils/ecgAttachments';

	import EcgPacemakerDetection from './EcgPacemakerDetection.svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';
	import Heart from '$lib/components/icons/Heart.svelte';
	import Cog6 from '$lib/components/icons/Cog6.svelte';

	const i18n = getContext<Writable<i18nType>>('i18n');

	export let files: Record<string, unknown>[] = [];
	// How many files the chat holds from its earlier messages, which every
	// message is sent with and the file limit counts.
	export let chatFileCount = 0;
	export let uploadFileHandler: (
		file: File,
		process?: boolean,
		itemData?: Record<string, unknown>
	) => Promise<unknown>;

	const LEAD_PRESETS: Record<string, readonly string[]> = {
		'PTB-XL': CANONICAL_LEADS,
		'MIMIC-IV-ECG': ['I', 'II', 'III', 'aVR', 'aVF', 'aVL', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6']
	};
	const DEFAULT_PRESET = 'PTB-XL';
	const DEFAULT_FS = 500;

	// Twice the renderer's default resolution, so the chat's viewer can zoom
	// into the preview and keep it sharp, or the default for a record too
	// long for a canvas to hold at twice it.
	const PREVIEW_RESOLUTIONS = [8, 4];

	// The largest file the bridge filter carries to the server; a recording
	// with a larger file would reach it as no recording at all.
	const MAX_FILE_BYTES = 16 * 1024 * 1024;

	const STORAGE_FS = 'ecg_fs';
	const STORAGE_LEADS = 'ecg_leads';
	const STORAGE_PRESET = 'ecg_preset';
	const STORAGE_SKIP = 'ecg_skip_modal';
	const STORAGE_SOURCE = 'ecg_source';
	const STORAGE_SAMPLE_DATASET = 'ecg_sample_dataset';

	type EcgPair = { dat: File; hea: File; stem: string };

	const SOURCES: readonly EcgSource[] = ['sample', 'recording'];

	const toolbarButtonClass =
		'bg-transparent hover:bg-gray-100 text-gray-700 dark:text-white dark:hover:bg-gray-800 rounded-full size-[1.875rem] flex justify-center items-center outline-hidden focus:outline-hidden shrink-0';
	const highContrastInputClass =
		'rounded-lg border border-gray-100/50 bg-gray-50/40 px-2 py-1.5 text-gray-700 outline-hidden transition-colors placeholder:text-gray-300 focus:border-blue-400 dark:border-white/[0.04] dark:bg-white/[0.03] dark:text-gray-300 dark:placeholder:text-gray-700 dark:focus:border-blue-500';
	const cancelButtonClass =
		'px-3.5 py-1.5 text-sm font-normal bg-gray-100 hover:bg-gray-100/70 text-gray-800 dark:bg-gray-850 dark:hover:bg-gray-850/60 dark:text-white transition rounded-full';
	const confirmButtonClass =
		'px-3.5 py-1.5 text-sm font-normal bg-black hover:bg-gray-800 text-white dark:bg-white dark:text-black dark:hover:bg-gray-200 transition rounded-full';

	// A choice among a few, such as a lead preset or a dataset.
	const pillButtonClass = (active: boolean) =>
		`px-3 py-1 rounded-full text-xs font-medium border transition ${
			active
				? 'bg-black text-white border-black dark:bg-white dark:text-black dark:border-white'
				: 'bg-transparent border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
		}`;
	const tabButtonClass = (active: boolean) =>
		`px-2.5 py-1 rounded-lg text-xs transition-colors duration-75 ${
			active
				? 'font-medium text-gray-900 dark:text-white bg-gray-50 dark:bg-white/[0.06]'
				: 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
		}`;

	let inputElement: HTMLInputElement;
	let showModal = false;
	// The dialog shows either the choice of where the ECG comes from or the
	// parameters a recording is read with.
	let view: 'source' | 'settings' = 'source';
	let source: EcgSource = 'sample';
	let pending: EcgPair | null = null;

	let fs: number | null = DEFAULT_FS;
	let leads: string[] = [...LEAD_PRESETS[DEFAULT_PRESET]];
	let skipModal = false;
	let draggingIndex: number | null = null;
	// Whether the analysis of the recording being attached runs pacemaker
	// detection. It is set for that one recording, so it is not stored with
	// the settings and starts off each time the dialog opens.
	let pacemakerDetection = false;

	let sampleIndex: EcgSampleIndex | null = null;
	let sampleIndexBase: string | null = null;
	let indexError: string | null = null;
	// Each index load and each sample fetch takes the next number, so a result
	// that arrives after a newer request, or after the dialog closed, is
	// dropped.
	let indexToken = 0;
	let attachToken = 0;
	let attachController: AbortController | null = null;
	let attachingSample = false;
	let datasetKey = '';
	let query = '';
	let selectedId: string | null = null;
	// The record being attached, or null: its name, and whether its entries
	// have started to reach the file list, which they do only once its
	// preview is drawn. Each attach takes the next number, so one still
	// awaiting an upload after a newer attach began leaves the files alone.
	let recordToken = 0;
	let attachingStem: string | null = null;
	let attachingListed = false;

	$: highContrast = $settings?.highContrastMode ?? false;
	$: labelClass = `text-xs ${highContrast ? 'text-gray-800 dark:text-gray-100' : 'text-gray-500'}`;

	$: activePreset =
		Object.keys(LEAD_PRESETS).find((name) =>
			LEAD_PRESETS[name].every((lead, index) => lead === leads[index])
		) ?? null;

	$: samplesBase = samplesBaseOf($models);
	$: shownIndex = sampleIndexBase === samplesBase ? sampleIndex : null;
	$: dataset =
		shownIndex?.datasets.find((entry) => entry.key === datasetKey) ??
		shownIndex?.datasets[0] ??
		null;
	$: search = dataset
		? searchSamples(dataset.samples, query)
		: { matches: [], total: 0, exact: null };
	// A query that is the id of a sample selects it, so Enter attaches it;
	// any other query selects nothing until a sample is picked, so Enter
	// never attaches a sample other than the one typed.
	$: selectedId = search.exact?.id ?? null;
	$: selectedSample = search.matches.find((sample) => sample.id === selectedId) ?? null;
	// A query that names a dataset in front of the id, as a sample id does,
	// is searched for in that dataset.
	$: followQueryDataset(query, shownIndex);

	$: if (showModal && view === 'source' && source === 'sample' && samplesBase !== null) {
		loadIndex(samplesBase);
	}

	// Closing the dialog any way but Confirm or Attach (Cancel, Escape, a
	// click outside) drops the pair waiting on it and abandons the sample
	// being fetched; Confirm and Attach take their record before closing.
	$: if (!showModal) {
		pending = null;
		cancelSampleFetch();
	}

	// The address the agent model's entry gives for its samples, or null when
	// the agent is not among the models or gives none.
	const samplesBaseOf = (entries: Model[]): string | null =>
		resolveSamplesBase(agentSamplesUrl(entries), WEBUI_BASE_URL);

	const readStoredSettings = () => {
		const storedFs = Number.parseFloat(localStorage.getItem(STORAGE_FS) ?? '');
		const presetName = localStorage.getItem(STORAGE_PRESET) ?? '';
		const presetLeads = Object.hasOwn(LEAD_PRESETS, presetName)
			? LEAD_PRESETS[presetName]
			: undefined;

		let storedLeads: string[] | null = null;
		try {
			const parsed = JSON.parse(localStorage.getItem(STORAGE_LEADS) ?? 'null');
			if (Array.isArray(parsed) && isCanonicalLeadSet(parsed)) {
				storedLeads = parsed;
			}
		} catch {
			storedLeads = null;
		}

		return {
			fs: Number.isFinite(storedFs) && storedFs > 0 ? storedFs : DEFAULT_FS,
			leads: [...(storedLeads ?? presetLeads ?? LEAD_PRESETS[DEFAULT_PRESET])],
			skip: localStorage.getItem(STORAGE_SKIP) === 'true'
		};
	};

	const persistSettings = () => {
		localStorage.setItem(STORAGE_FS, String(fs));
		localStorage.setItem(STORAGE_LEADS, JSON.stringify(leads));
		localStorage.setItem(STORAGE_PRESET, activePreset ?? 'Custom');
		localStorage.setItem(STORAGE_SKIP, String(skipModal));
	};

	const loadIndex = async (base: string) => {
		if (sampleIndexBase === base && sampleIndex !== null) {
			return;
		}
		const token = ++indexToken;
		indexError = null;
		try {
			const loaded = await loadSampleIndex(base);
			if (token !== indexToken) {
				return;
			}
			const storedKey = localStorage.getItem(STORAGE_SAMPLE_DATASET);
			datasetKey =
				loaded.datasets.find((entry) => entry.key === storedKey)?.key ??
				loaded.datasets[0]?.key ??
				'';
			sampleIndex = loaded;
			sampleIndexBase = base;
		} catch (error) {
			if (token === indexToken) {
				indexError = $i18n.t(error instanceof Error ? error.message : String(error));
			}
		}
	};

	const chooseSource = (next: EcgSource) => {
		// A sample still arriving would otherwise close the dialog over the
		// recording chosen meanwhile and be attached in its place.
		if (next !== 'sample') {
			cancelSampleFetch();
		}
		source = next;
		localStorage.setItem(STORAGE_SOURCE, next);
	};

	// The tab a key moves to: the arrows step through the tabs and wrap
	// around, Home and End go to the first and the last.
	const sourceAfterKey = (key: string): EcgSource | null => {
		if (key === 'ArrowRight' || key === 'ArrowLeft') {
			const step = key === 'ArrowRight' ? 1 : -1;
			return SOURCES[(SOURCES.indexOf(source) + step + SOURCES.length) % SOURCES.length];
		}
		if (key === 'Home') {
			return SOURCES[0];
		}
		if (key === 'End') {
			return SOURCES[SOURCES.length - 1];
		}
		return null;
	};

	const onSourceKeydown = async (event: KeyboardEvent) => {
		const next = sourceAfterKey(event.key);
		if (next === null) {
			return;
		}
		event.preventDefault();
		chooseSource(next);
		await tick();
		document.getElementById(`ecg-source-tab-${next}`)?.focus();
	};

	const chooseDataset = (key: string) => {
		datasetKey = key;
		localStorage.setItem(STORAGE_SAMPLE_DATASET, key);
	};

	const followQueryDataset = (text: string, loaded: EcgSampleIndex | null) => {
		const named = loaded === null ? null : datasetNamedBy(text, loaded.datasets);
		if (named !== null && named !== datasetKey) {
			chooseDataset(named);
		}
	};

	const optionId = (sample: EcgSample) => `ecg-sample-option-${sample.id}`;

	// The search field drives the list: the arrow keys move the selection,
	// Enter attaches the selected sample, and Escape clears the query before
	// it closes the dialog.
	const onSearchKeydown = async (event: KeyboardEvent) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			if (selectedSample !== null) {
				attachSample(selectedSample);
			}
			return;
		}
		if (event.key === 'Escape' && query !== '') {
			event.preventDefault();
			// The dialog closes on an Escape that reaches the window.
			event.stopPropagation();
			query = '';
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
			return;
		}
		event.preventDefault();
		const { matches } = search;
		if (matches.length === 0) {
			return;
		}
		const current = matches.findIndex((sample) => sample.id === selectedId);
		const step = event.key === 'ArrowDown' ? 1 : -1;
		const next =
			current === -1
				? step === 1
					? 0
					: matches.length - 1
				: Math.min(matches.length - 1, Math.max(0, current + step));
		selectedId = matches[next].id;
		await tick();
		document.getElementById(optionId(matches[next]))?.scrollIntoView({ block: 'nearest' });
	};

	// Focuses the element once the dialog has opened and placed its own
	// focus, unless the focus is on the source tabs, which the arrow keys are
	// moving through.
	const focusOnShow = (node: HTMLElement) => {
		const timer = setTimeout(() => {
			if (!document.activeElement?.closest('[role="tablist"]')) {
				node.focus();
			}
		}, 0);
		return {
			destroy() {
				clearTimeout(timer);
			}
		};
	};

	const stemOf = (name: string) => name.slice(0, name.lastIndexOf('.'));

	// The selected files as a record pair, or the sentence saying what is wrong.
	const pairOf = (selected: File[]): EcgPair | string => {
		const dats = selected.filter((file) => file.name.toLowerCase().endsWith('.dat'));
		const heas = selected.filter((file) => file.name.toLowerCase().endsWith('.hea'));

		if (dats.length + heas.length !== selected.length) {
			return $i18n.t('Only the .dat and .hea files of a WFDB record can be attached as an ECG.');
		}
		if (dats.length > 1 || heas.length > 1) {
			return $i18n.t('Select only one .dat and one .hea file at a time.');
		}
		if (dats.length === 0) {
			return $i18n.t(
				'The .dat file is missing: select the .dat and .hea files of the record together.'
			);
		}
		if (heas.length === 0) {
			return $i18n.t(
				'The .hea file is missing: select the .dat and .hea files of the record together.'
			);
		}

		const stem = stemOf(dats[0].name);
		if (stem !== stemOf(heas[0].name)) {
			return $i18n.t(
				'The .dat and .hea files must belong to the same record, but {{dat}} and {{hea}} are named differently.',
				{ dat: dats[0].name, hea: heas[0].name }
			);
		}
		// The server reads the record under this name.
		if (!isUsableRecordName(stem)) {
			return $i18n.t(
				'{{record}} cannot be attached as an ECG: a record name may hold only letters, digits, _ and -.',
				{ record: stem }
			);
		}
		const large = [dats[0], heas[0]].find((file) => file.size > MAX_FILE_BYTES);
		if (large !== undefined) {
			return $i18n.t('{{name}} is larger than 16 MiB, the most an ECG file can be.', {
				name: large.name
			});
		}

		return { dat: dats[0], hea: heas[0], stem };
	};

	// The text of the header file, or an empty one when it cannot be read.
	const readHeaderText = async (hea: File): Promise<string> => {
		try {
			return await hea.text();
		} catch {
			return '';
		}
	};

	const holdsRecord = (stem: string) => files.some((item) => ecgRecordOf(item) === stem);

	// Whether a record is still being attached: its preview is being drawn,
	// or the files hold entries of it. A record removed from the input is
	// no longer being attached, though an upload of it has yet to end.
	const isAttaching = () =>
		attachingStem !== null && (!attachingListed || holdsRecord(attachingStem));

	// The sentence saying why no record from `source` can be attached to the
	// message now, or null when one can. With no source, before one is
	// chosen, the file limit is checked for the source that adds the fewest
	// items, and the chosen source is checked again before its record is
	// uploaded.
	const refusal = (source: EcgSource | null): string | null => {
		// A temporary chat keeps files in the browser and extracts their text,
		// which a binary record has none of; the record has to be uploaded.
		if ($temporaryChatEnabled) {
			return $i18n.t('An ECG cannot be attached in a temporary chat.');
		}

		// The server reads one record per message, the last one attached, so
		// a second record would silently take the place of the first.
		if (isAttaching()) {
			return $i18n.t('An ECG is already being attached to this message.');
		}
		if (hasEcgAttachment(files)) {
			return $i18n.t('Only one ECG can be attached to a message. Remove the attached ECG first.');
		}

		// The upload limits sit under "file" in the runtime config, which the
		// Config type does not declare. The chat's files count as well, as they
		// do when the message is sent, so that no record is uploaded into a
		// message that could not be sent.
		const fileLimits = ($config as { file?: { max_count?: number | null } } | undefined)?.file;
		const maxCount = fileLimits?.max_count ?? null;
		if (exceedsFileLimit(files.length, chatFileCount, maxCount, source)) {
			return $i18n.t('You can only chat with a maximum of {{maxCount}} file(s) at a time.', {
				maxCount
			});
		}

		return null;
	};

	// Whether a record from `source` can be attached now, after saying why
	// not when it cannot. Checked again right before a record is uploaded,
	// since the files can change while the dialog is open or a sample is
	// fetched.
	const canAttach = (source: EcgSource | null): boolean => {
		const reason = refusal(source);
		if (reason !== null) {
			toast.error(reason);
			return false;
		}
		return true;
	};

	// Whether the message can be sent now, after saying why not when it
	// cannot: not while a record in it is still being attached or lacks an
	// item the server needs to read it, since the server would answer
	// without it.
	export const canSend = (): boolean => {
		const blocker = ecgSendBlocker(files, isAttaching());
		if (blocker === null) {
			return true;
		}
		toast.error(
			blocker === 'attaching'
				? $i18n.t('Wait until the ECG is attached.')
				: $i18n.t('The attached ECG is incomplete. Remove it and attach it again.')
		);
		return false;
	};

	const onFilesSelected = async (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const selected = Array.from(input.files ?? []);
		input.value = '';

		if (selected.length === 0) {
			return;
		}

		const pair = pairOf(selected);
		if (typeof pair === 'string') {
			toast.error(pair);
			return;
		}

		if (!canAttach('recording')) {
			return;
		}

		const detection = pacemakerDetection;

		// The server reads only records of the 12 standard leads.
		const headerText = await readHeaderText(pair.hea);
		const signalCount = statedSignalCount(headerText);
		if (signalCount !== CANONICAL_LEADS.length) {
			toast.error(
				signalCount === null
					? $i18n.t('{{name}} does not state how many signals the record has.', {
							name: pair.hea.name
						})
					: $i18n.t('The record has {{count}} signals instead of 12.', { count: signalCount })
			);
			return;
		}

		const stored = readStoredSettings();
		const header = parseWfdbHeader(headerText);
		const rate = header.fs ?? stored.fs;

		fs = rate;
		leads = header.leads ?? stored.leads;
		skipModal = stored.skip;

		// Without the settings step, the recording goes out with pacemaker
		// detection as it was set when its files were chosen; the settings
		// step shows it again, to be changed before the recording is confirmed.
		if (stored.skip) {
			showModal = false;
			if (canAttach('recording')) {
				await uploadRecord(pair, rate, [...leads], detection);
			}
		} else {
			pending = pair;
			view = 'settings';
			showModal = true;
		}
	};

	// Whether the upload of one file of the pair ended with its entry in place.
	// The handler removes the entry and reports the failure itself, so the
	// entry's status is the one reliable sign of success.
	const attached = (role: string, name: string) =>
		files.some(
			(item) => item?.ecg_role === role && item?.name === name && item?.status === 'uploaded'
		);

	// The preview picture of the record as a PNG file, drawn in the browser
	// from the pair at the given rate and with the given channel names.
	// Throws when the record cannot be drawn.
	const renderPreview = async (pair: EcgPair, rate: number | null, channels: string[]) => {
		if (rate === null || !Number.isFinite(rate) || rate <= 0) {
			throw new Error($i18n.t('Enter a sampling rate above 0 Hz.'));
		}
		const header = parseWfdbRecordHeader(await pair.hea.text());
		if (header.signals.length !== CANONICAL_LEADS.length) {
			throw new Error(
				$i18n.t('The record has {{count}} signals instead of 12.', {
					count: header.signals.length
				})
			);
		}
		const signals = readWfdbSignals(header, await pair.dat.arrayBuffer());
		const duration = Math.max(0, ...signals.map((signal) => signal.length)) / rate;
		const pxPerMm = fittingPxPerMm(CANONICAL_LEADS.length, duration, PREVIEW_RESOLUTIONS);
		const blob = await renderEcgImage(signals, rate, channels, { pxPerMm });
		return new File([blob], `${pair.stem}.png`, { type: 'image/png' });
	};

	// The preview, or null after a warning when it could not be drawn: the
	// record is attached without a picture then.
	const drawPreview = async (pair: EcgPair, rate: number | null, channels: string[]) => {
		try {
			return await renderPreview(pair, rate, channels);
		} catch (error) {
			// The sentence raised by the reader or the renderer is its own
			// translation key, so a locale can supply it and English is the
			// fallback.
			const reason = $i18n.t(error instanceof Error ? error.message : String(error));
			toast.warning($i18n.t('The ECG preview could not be drawn: {{reason}}', { reason }));
			return null;
		}
	};

	// Drops every entry of the record: its preview, its .hea and, for a
	// recording, its .dat.
	const removeRecord = (stem: string) => {
		files = withoutEcgRecord(files, stem);
	};

	// Uploads one file of the record attach `token` is attaching. The attach
	// is 'abandoned' once a newer one began or no entry of the record is
	// left, because the record was removed meanwhile or because the upload
	// of its first entry failed, which the handler has reported; the files
	// are left alone then. When the file's own upload failed, the rest of
	// the record is dropped and the attach has 'failed'.
	const uploadEntry = async (
		token: number,
		stem: string,
		file: File,
		itemData: Record<string, unknown>
	): Promise<'attached' | 'abandoned' | 'failed'> => {
		await uploadFileHandler(file, false, itemData);
		await tick();
		if (token !== recordToken || !holdsRecord(stem)) {
			return 'abandoned';
		}
		if (!attached(String(itemData.ecg_role), file.name)) {
			removeRecord(stem);
			return 'failed';
		}
		return 'attached';
	};

	// Attaches the record read at `rate` with `channels` naming its signals,
	// each entry carrying the record name, the label the chat shows the
	// record under (the record name, or the label `sample` gives) and
	// whether its analysis runs pacemaker detection (`detection`). A
	// recording is attached as its preview, its .dat and its .hea. A sample
	// is attached as its preview and its .hea, each also carrying the sample
	// id: the server reads a sample from its own copy, so its .dat, fetched
	// only to draw the preview, is not uploaded, and the .hea carries the
	// record to the server.
	const uploadRecord = async (
		pair: EcgPair,
		rate: number,
		channels: string[],
		detection: boolean,
		sample: { id: string; label: string } | null = null
	) => {
		const shared = {
			ecg_record: pair.stem,
			ecg_label: sample?.label ?? pair.stem,
			ecg_pacemaker_detection: detection,
			...(sample === null ? {} : { ecg_sample: sample.id })
		};
		// The record is uploaded without text extraction and marked as full
		// context, so the retrieval step neither asks the model for search
		// queries over it nor looks for chunks it does not have.
		const itemData = {
			context: 'full',
			ecg_fs: rate,
			ecg_leads: [...channels],
			...shared
		};

		const token = ++recordToken;
		attachingStem = pair.stem;
		attachingListed = false;
		try {
			// The preview goes up first, as a plain image, so the chat shows the
			// picture and sends it to the model beside the record's files.
			const preview = await drawPreview(pair, rate, [...channels]);
			attachingListed = true;
			if (preview !== null) {
				const previewUpload = await uploadEntry(token, pair.stem, preview, {
					ecg_role: 'preview',
					...shared
				});
				if (previewUpload !== 'attached') {
					return;
				}
			}

			if (sample === null) {
				const signalUpload = await uploadEntry(token, pair.stem, pair.dat, {
					...itemData,
					ecg_role: 'signal'
				});
				if (signalUpload !== 'attached') {
					return;
				}
			}

			const headerUpload = await uploadEntry(token, pair.stem, pair.hea, {
				...itemData,
				ecg_role: 'header'
			});
			// For a sample, the entry removed with a failed .hea is its preview:
			// without one, the .hea is the first entry, whose failure the
			// handler reports.
			if (headerUpload === 'failed') {
				toast.error(
					sample === null
						? $i18n.t('The .hea file could not be attached, so {{name}} was removed again.', {
								name: pair.dat.name
							})
						: $i18n.t('The .hea file could not be attached, so the ECG preview was removed again.')
				);
			}
			if (headerUpload !== 'attached') {
				return;
			}
		} finally {
			if (token === recordToken) {
				attachingStem = null;
			}
		}

		toast.success($i18n.t('ECG attached: {{record}}', { record: shared.ecg_label }));
	};

	const cancelSampleFetch = () => {
		attachToken += 1;
		attachController?.abort();
		attachController = null;
		attachingSample = false;
	};

	// Fetches the files of the sample, draws its preview from them and
	// attaches the preview and the .hea, at the rate and with the channel
	// names its header states, and with the sample id, a label naming its
	// dataset and ECG id, and pacemaker detection as it was set when the
	// sample was picked on every entry. The dialog stays open while the files
	// arrive, with that toggle locked, and the parameters it holds for
	// recordings stay as they are.
	const attachSample = async (sample: EcgSample) => {
		const base = samplesBase;
		if (attachingSample || base === null) {
			return;
		}

		if (!canAttach('sample')) {
			return;
		}
		const detection = pacemakerDetection;
		const datasetLabel =
			shownIndex?.datasets.find((entry) => entry.key === sample.dataset)?.label ?? sample.dataset;

		const token = ++attachToken;
		const controller = new AbortController();
		attachController = controller;
		attachingSample = true;

		let pair: EcgPair;
		let header: WfdbHeader;
		try {
			pair = await fetchSampleRecord(base, sample.id, sample.stem, controller.signal);
			header = parseWfdbHeader(await pair.hea.text());
		} catch (error) {
			if (token === attachToken) {
				attachingSample = false;
				attachController = null;
				const reason = $i18n.t(error instanceof Error ? error.message : String(error));
				toast.error(
					$i18n.t('Sample {{sample}} could not be fetched: {{reason}}', {
						sample: sample.id,
						reason
					})
				);
			}
			return;
		}
		if (token !== attachToken) {
			return;
		}
		attachingSample = false;
		attachController = null;

		if (header.fs === null || header.leads === null) {
			toast.error(
				$i18n.t(
					'The header of sample {{sample}} does not state a sampling rate and the 12 standard leads.',
					{ sample: sample.id }
				)
			);
			return;
		}

		showModal = false;
		if (canAttach('sample')) {
			await uploadRecord(pair, header.fs, header.leads, detection, {
				id: sample.id,
				label: `${datasetLabel} ${sample.ecgId}`
			});
		}
	};

	const openSource = () => {
		if (!canAttach(null)) {
			return;
		}
		const storedSource = localStorage.getItem(STORAGE_SOURCE);
		source = SOURCES.find((entry) => entry === storedSource) ?? 'sample';
		query = '';
		pending = null;
		pacemakerDetection = false;
		view = 'source';
		showModal = true;
	};

	// Opens the file picker, unless a recording cannot be attached now: the
	// dialog opens while a sample, which adds fewer files, still fits.
	const chooseRecordingFiles = () => {
		if (canAttach('recording')) {
			inputElement.click();
		}
	};

	const openSettings = () => {
		const stored = readStoredSettings();
		fs = stored.fs;
		leads = stored.leads;
		skipModal = stored.skip;

		pending = null;
		pacemakerDetection = false;
		view = 'settings';
		showModal = true;
	};

	const confirm = async () => {
		if (fs === null || !Number.isFinite(fs) || fs <= 0) {
			toast.error($i18n.t('Enter a sampling rate above 0 Hz.'));
			return;
		}

		persistSettings();

		const pair = pending;
		const rate = fs;
		const detection = pacemakerDetection;
		pending = null;
		showModal = false;

		if (pair && canAttach('recording')) {
			await uploadRecord(pair, rate, [...leads], detection);
		}
	};

	const cancel = () => {
		showModal = false;
	};

	const moveLead = (from: number, to: number) => {
		if (from === to || to < 0 || to >= leads.length) {
			return;
		}
		const reordered = [...leads];
		const [lead] = reordered.splice(from, 1);
		reordered.splice(to, 0, lead);
		leads = reordered;
	};

	const onLeadKeydown = (event: KeyboardEvent, index: number) => {
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			moveLead(index, index - 1);
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			moveLead(index, index + 1);
		}
	};

	// Firefox starts a drag only when the drag carries data.
	const onLeadDragStart = (event: DragEvent, index: number) => {
		event.dataTransfer?.setData('text/plain', String(index));
		draggingIndex = index;
	};

	const onLeadDrop = (event: DragEvent, index: number) => {
		event.preventDefault();
		if (draggingIndex !== null) {
			moveLead(draggingIndex, index);
		}
		draggingIndex = null;
	};
</script>

<div class="flex items-center shrink-0">
	<input
		bind:this={inputElement}
		type="file"
		accept=".dat,.hea"
		multiple
		hidden
		on:change={onFilesSelected}
	/>

	<Tooltip content={$i18n.t('Attach ECG')} placement="top">
		<button
			type="button"
			id="ecg-attach-button"
			class={toolbarButtonClass}
			aria-label={$i18n.t('Attach ECG')}
			on:click={openSource}
		>
			<Heart className="size-4.5" strokeWidth="1.5" />
		</button>
	</Tooltip>

	<Tooltip content={$i18n.t('ECG settings')} placement="top">
		<button
			type="button"
			id="ecg-settings-button"
			class={toolbarButtonClass}
			aria-label={$i18n.t('ECG settings')}
			on:click={openSettings}
		>
			<Cog6 className="size-4.5" strokeWidth="1.5" />
		</button>
	</Tooltip>
</div>

<Modal bind:show={showModal} size="sm">
	<div class="flex flex-col h-full">
		<div class="flex justify-between items-center dark:text-gray-100 px-4 pt-3 pb-1">
			<h1 class="text-sm font-medium self-center">
				{view === 'source' ? $i18n.t('Attach ECG') : $i18n.t('ECG parameters')}
			</h1>
			<button
				class="self-center rounded-lg p-1 text-gray-500 transition hover:bg-gray-50 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
				aria-label={$i18n.t('Close modal')}
				on:click={cancel}
			>
				<XMark className="size-4" />
			</button>
		</div>

		{#if view === 'source'}
			<div class="px-5 pb-4 flex flex-col gap-3 dark:text-gray-100">
				<div class="flex items-center gap-1" role="tablist" aria-label={$i18n.t('ECG source')}>
					{#each SOURCES as entry (entry)}
						<button
							type="button"
							role="tab"
							id="ecg-source-tab-{entry}"
							aria-controls={source === entry ? `ecg-source-panel-${entry}` : undefined}
							aria-selected={source === entry}
							tabindex={source === entry ? 0 : -1}
							class={tabButtonClass(source === entry)}
							on:click={() => chooseSource(entry)}
							on:keydown={onSourceKeydown}
						>
							{entry === 'sample' ? $i18n.t('Benchmark sample') : $i18n.t('My recording')}
						</button>
					{/each}
				</div>

				{#if source === 'sample'}
					<div
						role="tabpanel"
						id="ecg-source-panel-sample"
						aria-labelledby="ecg-source-tab-sample"
						class="flex flex-col gap-2"
					>
						{#if samplesBase === null}
							<div class="text-sm text-gray-500">{$i18n.t('No samples are available.')}</div>
						{:else if indexError !== null}
							<div class="flex items-center justify-between gap-2 text-sm" role="alert">
								<span class="text-red-600 dark:text-red-400">
									{$i18n.t('The sample list could not be loaded: {{reason}}', {
										reason: indexError
									})}
								</span>
								<button
									type="button"
									class="{pillButtonClass(false)} shrink-0"
									on:click={() => samplesBase !== null && loadIndex(samplesBase)}
								>
									{$i18n.t('Retry')}
								</button>
							</div>
						{:else if shownIndex === null}
							<div class="flex items-center gap-2 text-sm text-gray-500">
								<Spinner className="size-4" />
								{$i18n.t('Loading samples...')}
							</div>
						{:else if dataset === null}
							<div class="text-sm text-gray-500">{$i18n.t('No samples are available.')}</div>
						{:else}
							<div>
								<div class={labelClass}>{$i18n.t('Dataset')}</div>
								<div class="flex items-center gap-2 mt-1.5">
									{#each shownIndex.datasets as entry (entry.key)}
										<button
											type="button"
											class={pillButtonClass(dataset.key === entry.key)}
											aria-pressed={dataset.key === entry.key}
											on:click={() => chooseDataset(entry.key)}
										>
											{entry.label}
										</button>
									{/each}
								</div>
							</div>

							<div>
								<label for="ecg-sample-search" class={labelClass}>{$i18n.t('ECG id')}</label>
								<input
									id="ecg-sample-search"
									type="search"
									inputmode="numeric"
									autocomplete="off"
									spellcheck="false"
									class={`w-full text-sm ${highContrast ? highContrastInputClass : 'bg-transparent outline-hidden placeholder:text-gray-300 dark:placeholder:text-gray-700'}`}
									placeholder={$i18n.t('Search by ECG id')}
									role="combobox"
									aria-autocomplete="list"
									aria-expanded={search.matches.length > 0}
									aria-controls="ecg-sample-listbox"
									aria-activedescendant={selectedSample ? optionId(selectedSample) : undefined}
									bind:value={query}
									use:focusOnShow
									on:keydown={onSearchKeydown}
								/>
							</div>

							<div
								id="ecg-sample-listbox"
								role="listbox"
								aria-label={$i18n.t('Samples of {{dataset}}', { dataset: dataset.label })}
								class="max-h-56 overflow-y-auto rounded-lg border border-gray-100 p-0.5 dark:border-gray-800"
								class:hidden={search.matches.length === 0}
							>
								{#each search.matches as sample (sample.id)}
									<button
										type="button"
										role="option"
										id={optionId(sample)}
										aria-selected={sample.id === selectedId}
										tabindex="-1"
										class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors {sample.id ===
										selectedId
											? 'bg-gray-100 dark:bg-gray-800'
											: 'hover:bg-gray-50 dark:hover:bg-gray-850'}"
										on:mousedown={(event) => {
											// Keeps the focus in the search field, which the
											// arrow keys and Enter act through.
											event.preventDefault();
										}}
										on:click={() => {
											selectedId = sample.id;
										}}
										on:dblclick={() => attachSample(sample)}
									>
										<span class="tabular-nums">{sample.ecgId}</span>
										<span class="text-xs font-mono text-gray-400 dark:text-gray-500">
											{sample.stem}
										</span>
									</button>
								{/each}
							</div>
							{#if search.matches.length === 0}
								<div class="text-sm text-gray-500">
									{$i18n.t('No sample of {{dataset}} has this id.', { dataset: dataset.label })}
								</div>
							{/if}

							<div class="flex items-center justify-between gap-2 text-xs text-gray-400">
								<span class="shrink-0" aria-live="polite">
									{$i18n.t('Showing {{shown}} of {{total}}', {
										shown: search.matches.length,
										total: search.total
									})}
								</span>
								<a
									href={dataset.url}
									target="_blank"
									rel="noopener noreferrer"
									class="min-w-0 truncate underline hover:text-gray-600 dark:hover:text-gray-300"
								>
									{dataset.attribution.includes(dataset.license)
										? dataset.attribution
										: `${dataset.attribution} (${dataset.license})`}
								</a>
							</div>

							<EcgPacemakerDetection bind:checked={pacemakerDetection} disabled={attachingSample} />
						{/if}

						<div class="flex justify-end gap-2 pt-1">
							<button type="button" class={cancelButtonClass} on:click={cancel}>
								{$i18n.t('Cancel')}
							</button>
							<button
								type="button"
								class="{confirmButtonClass} flex items-center gap-1.5 disabled:opacity-50"
								disabled={selectedSample === null || attachingSample}
								on:click={() => selectedSample !== null && attachSample(selectedSample)}
							>
								{#if attachingSample}
									<Spinner className="size-3.5" />
								{/if}
								{$i18n.t('Attach')}
							</button>
						</div>
					</div>
				{:else}
					<div
						role="tabpanel"
						id="ecg-source-panel-recording"
						aria-labelledby="ecg-source-tab-recording"
						class="flex flex-col gap-3"
					>
						<div class="text-sm text-gray-600 dark:text-gray-300">
							{$i18n.t('Attach a 12-lead WFDB record from your computer: its .dat and .hea files.')}
						</div>

						<!-- Asked before the files are chosen, since a recording attached with
						     the settings step skipped goes out with what is ticked here. -->
						<EcgPacemakerDetection bind:checked={pacemakerDetection} />

						<div class="flex justify-end gap-2 pt-1">
							<button type="button" class={cancelButtonClass} on:click={cancel}>
								{$i18n.t('Cancel')}
							</button>
							<button type="button" class={confirmButtonClass} on:click={chooseRecordingFiles}>
								{$i18n.t('Choose files')}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{:else}
			<div class="px-5 pb-4 flex flex-col gap-3 dark:text-gray-100">
				<div>
					<label for="ecg-fs" class={labelClass}>{$i18n.t('Sampling rate (Hz)')}</label>
					<input
						id="ecg-fs"
						type="number"
						min="1"
						step="any"
						class={`w-full text-sm ${highContrast ? highContrastInputClass : 'bg-transparent outline-hidden placeholder:text-gray-300 dark:placeholder:text-gray-700'}`}
						bind:value={fs}
						placeholder={String(DEFAULT_FS)}
					/>
				</div>

				<div>
					<div class={labelClass}>{$i18n.t('Lead order')}</div>

					<div class="flex items-center gap-2 mt-1.5">
						{#each Object.keys(LEAD_PRESETS) as name (name)}
							<button
								type="button"
								class={pillButtonClass(activePreset === name)}
								aria-pressed={activePreset === name}
								on:click={() => (leads = [...LEAD_PRESETS[name]])}
							>
								{name}
							</button>
						{/each}
						{#if activePreset === null}
							<span class="text-xs italic text-gray-400 dark:text-gray-500">
								{$i18n.t('(customized)')}
							</span>
						{/if}
					</div>

					<div class="grid grid-cols-6 gap-1.5 mt-2">
						{#each leads as lead, index (lead)}
							<div
								role="button"
								tabindex="0"
								draggable="true"
								aria-label={$i18n.t('{{lead}}, position {{position}} of {{count}}', {
									lead,
									position: index + 1,
									count: leads.length
								})}
								class="flex items-center justify-center py-1.5 rounded-lg border text-sm font-medium select-none cursor-grab active:cursor-grabbing transition border-gray-200 bg-gray-50 text-gray-800 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:border-gray-600 {draggingIndex ===
								index
									? 'opacity-50'
									: ''}"
								on:dragstart={(event) => onLeadDragStart(event, index)}
								on:dragover={(event) => event.preventDefault()}
								on:drop={(event) => onLeadDrop(event, index)}
								on:dragend={() => (draggingIndex = null)}
								on:keydown={(event) => onLeadKeydown(event, index)}
							>
								{lead}
							</div>
						{/each}
					</div>

					<div class="text-xs text-gray-400 dark:text-gray-500 mt-1.5">
						{$i18n.t('Drag a lead, or focus it and press the left or right arrow key, to move it.')}
					</div>
				</div>

				<!-- Asked only of the recording being attached, not of the settings alone,
				     and holding what was ticked before its files were chosen. -->
				{#if pending !== null}
					<EcgPacemakerDetection bind:checked={pacemakerDetection} />
				{/if}

				<label class="flex items-center gap-2 cursor-pointer {labelClass}">
					<input type="checkbox" class="size-3.5" bind:checked={skipModal} />
					{$i18n.t('Save these settings and skip this dialog next time')}
				</label>

				<div class="flex justify-end gap-2 pt-1">
					<button type="button" class={cancelButtonClass} on:click={cancel}>
						{$i18n.t('Cancel')}
					</button>
					<button type="button" class={confirmButtonClass} on:click={confirm}>
						{$i18n.t('Confirm')}
					</button>
				</div>
			</div>
		{/if}
	</div>
</Modal>
