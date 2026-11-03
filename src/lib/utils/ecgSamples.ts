/**
 * The benchmark records the ECG agent server offers as samples: reading its
 * index, finding a sample by the id the benchmark gives it, and fetching the
 * WFDB files of one sample.
 */

import { ECG_AGENT_MODEL_ID } from './ecgViewer';

/** The characters a dataset key, an ECG id or a record stem may hold. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * A dataset named in front of the id in a lower-cased query, the way a
 * sample id (`ptbxl-141`) or a label (`ptb-xl 00141_hr`) puts it: a word of
 * letters, digits and dashes that starts with a letter, then dashes or
 * spaces, then the digits of the id, with or without the `s` of a MIMIC
 * study folder, or nothing yet. The word is the first group.
 */
const DATASET_PREFIX = /^([a-z][a-z0-9-]*?)[-\s]+(?=s?\d|$)/;

/** The address the server publishes its samples under unless it is told another. */
export const DEFAULT_SAMPLES_URL = '/ecg-samples';

export type EcgSample = {
	/** The id the server serves the files under: `<dataset key>-<ecg id>`. */
	id: string;
	dataset: string;
	/** The id the benchmark gives the record, e.g. `141` or a MIMIC study id. */
	ecgId: string;
	/** The WFDB record name, e.g. `00141_hr`. */
	stem: string;
	/** The ECG id normalized the way a query is, which a search compares against. */
	searchKey: string;
};

export type EcgSampleDataset = {
	key: string;
	label: string;
	license: string;
	url: string;
	attribution: string;
	samples: EcgSample[];
};

export type EcgSampleIndex = {
	version: 1;
	datasets: EcgSampleDataset[];
};

export type EcgSampleSearch = {
	matches: EcgSample[];
	/** How many samples match, of which `matches` holds at most the limit. */
	total: number;
	/** The sample whose id the query is, however it spells it, or null. */
	exact: EcgSample | null;
};

export type EcgSampleRecord = { dat: File; hea: File; stem: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const requireString = (value: unknown, what: string): string => {
	if (typeof value !== 'string') {
		throw new Error(`The sample index gives ${what} that is not a string.`);
	}
	return value;
};

const requireName = (value: unknown, what: string): string => {
	const name = requireString(value, what);
	if (!NAME_PATTERN.test(name)) {
		throw new Error(
			`The sample index gives ${what} with characters outside A-Z, a-z, 0-9, _ and -.`
		);
	}
	return name;
};

/**
 * Normalizes an ECG id or a query for matching: trimmed and lower-cased,
 * without a dataset named in front of the id (`ptbxl-`, `mimic-iv-ecg-`,
 * `PTB-XL `), the `s` a MIMIC study folder puts before the digits, a `_hr`
 * or `_lr` record suffix, and leading zeros, so `ptbxl-141`, `00141_hr` and
 * `PTB-XL 00141_hr` all find `141`, and `s41084804` finds `41084804`.
 */
export const normalizeSampleQuery = (query: string): string =>
	query
		.trim()
		.toLowerCase()
		.replace(DATASET_PREFIX, '')
		.replace(/^s(?=\d)/, '')
		.replace(/_[hl]r$/, '')
		.replace(/^0+(?=\d)/, '');

/**
 * The key of the dataset a query names in front of the id, by its key
 * (`ptbxl-141`) or by its label (`PTB-XL 00141_hr`) in any case, or null
 * when it names none of `datasets`.
 */
export const datasetNamedBy = (
	query: string,
	datasets: readonly Pick<EcgSampleDataset, 'key' | 'label'>[]
): string | null => {
	const name = DATASET_PREFIX.exec(query.trim().toLowerCase())?.[1];
	if (name === undefined) {
		return null;
	}
	return (
		datasets.find(
			(dataset) => dataset.key.toLowerCase() === name || dataset.label.toLowerCase() === name
		)?.key ?? null
	);
};

/**
 * The order of two samples by their normalized ids: numeric order for ids
 * of digits, since a shorter digit string without leading zeros is smaller.
 */
const compareSamples = (a: EcgSample, b: EcgSample): number =>
	a.searchKey.length - b.searchKey.length ||
	(a.searchKey < b.searchKey ? -1 : a.searchKey > b.searchKey ? 1 : 0);

const parseDataset = (value: unknown, position: number): EcgSampleDataset => {
	if (!isObject(value)) {
		throw new Error(`Dataset ${position} of the sample index is not an object.`);
	}
	const key = requireName(value.key, `a dataset key`);
	const url = requireString(value.url, `the address of dataset ${key}`);
	if (!/^https?:\/\//i.test(url)) {
		throw new Error(`The sample index gives dataset ${key} an address that is not http(s).`);
	}
	if (!Array.isArray(value.samples)) {
		throw new Error(`The sample index lists no samples for dataset ${key}.`);
	}

	const samples = value.samples.map((entry: unknown): EcgSample => {
		if (!Array.isArray(entry) || entry.length !== 2) {
			throw new Error(`A sample of dataset ${key} is not an [ecg id, stem] pair.`);
		}
		const ecgId = requireName(entry[0], `an ECG id in dataset ${key}`);
		const stem = requireName(entry[1], `a record stem in dataset ${key}`);
		return {
			id: `${key}-${ecgId}`,
			dataset: key,
			ecgId,
			stem,
			searchKey: normalizeSampleQuery(ecgId)
		};
	});

	return {
		key,
		label: requireString(value.label, `the label of dataset ${key}`),
		license: requireString(value.license, `the license of dataset ${key}`),
		url,
		attribution: requireString(value.attribution, `the attribution of dataset ${key}`),
		samples: samples.sort(compareSamples)
	};
};

/**
 * Reads the sample index the server publishes:
 * `{"version": 1, "datasets": [{key, label, license, url, attribution, samples: [[ecg_id, stem], ...]}, ...]}`.
 * The samples of each dataset come out in the numeric order of their ids.
 * Throws an Error for another version, a field of the wrong type, a key, ECG
 * id or stem with characters outside `A-Za-z0-9_-`, an address that is not
 * http(s), and two samples or datasets with the same id.
 */
export const parseSampleIndex = (json: unknown): EcgSampleIndex => {
	if (!isObject(json)) {
		throw new Error('The sample index is not an object.');
	}
	if (json.version !== 1) {
		throw new Error('The sample index is of a version this page cannot read.');
	}
	if (!Array.isArray(json.datasets)) {
		throw new Error('The sample index lists no datasets.');
	}

	const datasets = json.datasets.map(parseDataset);

	const keys = new Set<string>();
	const ids = new Set<string>();
	for (const dataset of datasets) {
		if (keys.has(dataset.key)) {
			throw new Error(`The sample index lists dataset ${dataset.key} twice.`);
		}
		keys.add(dataset.key);
		for (const sample of dataset.samples) {
			if (ids.has(sample.id)) {
				throw new Error(`The sample index lists sample ${sample.id} twice.`);
			}
			ids.add(sample.id);
		}
	}

	return { version: 1, datasets };
};

/**
 * The samples whose ids match the query: an exact match first, then the ids
 * the query starts, then the ids that contain it, each group in the order
 * of the samples given. An empty query matches every sample and is the id
 * of none. `matches` holds at most `limit` samples and `total` counts them
 * all.
 */
export const searchSamples = (
	samples: readonly EcgSample[],
	query: string,
	limit = 50
): EcgSampleSearch => {
	const key = normalizeSampleQuery(query);
	if (key === '') {
		return { matches: samples.slice(0, limit), total: samples.length, exact: null };
	}

	const exact: EcgSample[] = [];
	const prefix: EcgSample[] = [];
	const substring: EcgSample[] = [];
	for (const sample of samples) {
		if (sample.searchKey === key) {
			exact.push(sample);
		} else if (sample.searchKey.startsWith(key)) {
			prefix.push(sample);
		} else if (sample.searchKey.includes(key)) {
			substring.push(sample);
		}
	}

	const all = [...exact, ...prefix, ...substring];
	return { matches: all.slice(0, limit), total: all.length, exact: exact[0] ?? null };
};

const withoutTrailingSlashes = (url: string): string => url.replace(/\/+$/, '');

type ModelEntry = {
	id?: unknown;
	ecg_samples_url?: unknown;
	info?: { base_model_id?: unknown } | null;
};

/**
 * The `ecg_samples_url` a model list gives for the samples: that of the
 * agent model, whose id the bridge filter hands records to only when it is
 * exactly `ecg-reasoning-agent`. A list that offers the agent only through
 * a workspace preset built on it gives the server's default address, since
 * a preset's entry carries none of its base model's fields. Null when the
 * agent entry gives no address, or neither entry is listed.
 */
export const agentSamplesUrl = (entries: readonly ModelEntry[]): string | null => {
	const agent = entries.find((entry) => entry?.id === ECG_AGENT_MODEL_ID);
	if (agent !== undefined) {
		return typeof agent.ecg_samples_url === 'string' ? agent.ecg_samples_url : null;
	}
	const preset = entries.some((entry) => entry?.info?.base_model_id === ECG_AGENT_MODEL_ID);
	return preset ? DEFAULT_SAMPLES_URL : null;
};

/** The address of one file of a sample, `<base>/<sample id>.<ext>`. */
export const sampleFileUrl = (base: string, sampleId: string, ext: 'hea' | 'dat'): string =>
	`${withoutTrailingSlashes(base)}/${encodeURIComponent(sampleId)}.${ext}`;

/**
 * The address the samples are fetched from, given the `ecg_samples_url` of
 * the agent model: an absolute http(s) address as it is, a path of its own
 * (starting with a single `/`) under the Open WebUI base address, without
 * trailing slashes either way. Anything else, the root path included, gives
 * null.
 */
export const resolveSamplesBase = (url: unknown, webuiBaseUrl: string): string | null => {
	if (typeof url !== 'string') {
		return null;
	}
	const trimmed = url.trim();
	if (/^https?:\/\/[^/]/i.test(trimmed)) {
		return withoutTrailingSlashes(trimmed);
	}
	if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
		const path = withoutTrailingSlashes(trimmed);
		return path === '' ? null : `${withoutTrailingSlashes(webuiBaseUrl)}${path}`;
	}
	return null;
};

const indexCache = new Map<string, Promise<EcgSampleIndex>>();

/**
 * The sample index served under `base`, fetched once per page. A load that
 * fails is forgotten, so the next call tries again.
 */
export const loadSampleIndex = (
	base: string,
	fetchFn: typeof fetch = fetch
): Promise<EcgSampleIndex> => {
	const cached = indexCache.get(base);
	if (cached !== undefined) {
		return cached;
	}

	const loading = (async () => {
		const res = await fetchFn(`${withoutTrailingSlashes(base)}/index.json`);
		if (!res.ok) {
			throw new Error(`The sample index could not be fetched (HTTP ${res.status}).`);
		}
		let json: unknown;
		try {
			json = await res.json();
		} catch {
			throw new Error('The sample index is not valid JSON.');
		}
		return parseSampleIndex(json);
	})();

	indexCache.set(base, loading);
	loading.catch(() => {
		if (indexCache.get(base) === loading) {
			indexCache.delete(base);
		}
	});
	return loading;
};

const fetchSampleFile = async (
	url: string,
	name: string,
	type: string,
	signal: AbortSignal | undefined,
	fetchFn: typeof fetch
): Promise<File> => {
	const res = await fetchFn(url, { signal });
	if (!res.ok) {
		throw new Error(`${name} could not be fetched (HTTP ${res.status}).`);
	}
	return new File([await res.blob()], name, { type });
};

/**
 * The .dat and .hea files of a sample, named `<stem>.dat` and `<stem>.hea`
 * like the files of a recording the user picks. Rejects when either file
 * cannot be fetched, and with an AbortError once `signal` aborts.
 */
export const fetchSampleRecord = async (
	base: string,
	sampleId: string,
	stem: string,
	signal?: AbortSignal,
	fetchFn: typeof fetch = fetch
): Promise<EcgSampleRecord> => {
	const [hea, dat] = await Promise.all([
		fetchSampleFile(
			sampleFileUrl(base, sampleId, 'hea'),
			`${stem}.hea`,
			'text/plain',
			signal,
			fetchFn
		),
		fetchSampleFile(
			sampleFileUrl(base, sampleId, 'dat'),
			`${stem}.dat`,
			'application/octet-stream',
			signal,
			fetchFn
		)
	]);
	return { dat, hea, stem };
};
