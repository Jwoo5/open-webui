import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SAMPLES_URL,
	agentSamplesUrl,
	datasetNamedBy,
	fetchSampleRecord,
	loadSampleIndex,
	normalizeSampleQuery,
	parseSampleIndex,
	resolveSamplesBase,
	sampleFileUrl,
	searchSamples
} from './ecgSamples';

const ptbxl = (samples: unknown[]) => ({
	key: 'ptbxl',
	label: 'PTB-XL',
	license: 'CC BY 4.0',
	url: 'https://physionet.org/content/ptb-xl/1.0.3/',
	attribution: 'PTB-XL, PhysioNet (CC BY 4.0)',
	samples
});

const mimic = (samples: unknown[]) => ({
	key: 'mimic-iv-ecg',
	label: 'MIMIC-IV-ECG',
	license: 'ODbL 1.0',
	url: 'https://physionet.org/content/mimic-iv-ecg/1.0/',
	attribution: 'MIMIC-IV-ECG, PhysioNet (ODbL 1.0)',
	samples
});

const index = (...datasets: unknown[]) => ({ version: 1, datasets });

describe('parseSampleIndex', () => {
	it('reads both datasets and names each sample after its dataset', () => {
		const parsed = parseSampleIndex(
			index(
				ptbxl([
					['141', '00141_hr'],
					['13665', '13665_hr']
				]),
				mimic([['41084804', '41084804']])
			)
		);

		expect(parsed.version).toBe(1);
		expect(parsed.datasets.map((dataset) => dataset.key)).toEqual(['ptbxl', 'mimic-iv-ecg']);
		expect(parsed.datasets[0]).toMatchObject({
			label: 'PTB-XL',
			license: 'CC BY 4.0',
			attribution: 'PTB-XL, PhysioNet (CC BY 4.0)'
		});
		expect(parsed.datasets[0].samples[0]).toEqual({
			id: 'ptbxl-141',
			dataset: 'ptbxl',
			ecgId: '141',
			stem: '00141_hr',
			searchKey: '141'
		});
		expect(parsed.datasets[1].samples[0].id).toBe('mimic-iv-ecg-41084804');
	});

	it('puts the samples of a dataset in the numeric order of their ids', () => {
		const parsed = parseSampleIndex(
			index(
				ptbxl([
					['13665', '13665_hr'],
					['3', '00003_hr'],
					['141', '00141_hr'],
					['21837', '21837_hr']
				])
			)
		);

		expect(parsed.datasets[0].samples.map((sample) => sample.ecgId)).toEqual([
			'3',
			'141',
			'13665',
			'21837'
		]);
	});

	it.each([
		['a key outside the allowed characters', index({ ...ptbxl([]), key: 'ptb xl' })],
		['a stem outside the allowed characters', index(ptbxl([['141', '../00141_hr']]))],
		['an ECG id outside the allowed characters', index(ptbxl([['14/1', '00141_hr']]))],
		[
			'a duplicate sample id',
			index(
				ptbxl([
					['141', '00141_hr'],
					['141', '00141_lr']
				])
			)
		],
		['a duplicate dataset', index(ptbxl([]), ptbxl([]))],
		['another version', { ...index(ptbxl([])), version: 2 }],
		['no dataset list', { version: 1 }],
		['a dataset that is not an object', index(['ptbxl'])],
		['a sample that is not a pair', index(ptbxl([['141']]))],
		['a sample given as an object', index(ptbxl([{ ecg_id: '141', stem: '00141_hr' }]))],
		['a numeric ECG id', index(ptbxl([[141, '00141_hr']]))],
		['a label that is not a string', index({ ...ptbxl([]), label: null })],
		['an address that is not http(s)', index({ ...ptbxl([]), url: 'javascript:alert(1)' })],
		['no sample list', index({ ...ptbxl([]), samples: undefined })],
		['a value that is not an object', [index(ptbxl([]))]]
	])('refuses %s', (_, json) => {
		expect(() => parseSampleIndex(json)).toThrow(Error);
	});
});

describe('normalizeSampleQuery', () => {
	it.each([
		['  141 ', '141'],
		['00141', '141'],
		['00141_hr', '141'],
		['00141_LR', '141'],
		['ptbxl-141', '141'],
		['PTBXL-00141_hr', '141'],
		['mimic-iv-ecg-41084804', '41084804'],
		['s41084804', '41084804'],
		['S41084804', '41084804'],
		['mimic-iv-ecg-s41084804', '41084804'],
		['PTB-XL 00141_hr', '141'],
		['ptb-xl-141', '141'],
		['MIMIC-IV-ECG  s41084804', '41084804'],
		['ptbxl-', ''],
		['000', '0'],
		['', ''],
		['sinus', 'sinus']
	])('normalizes %j to %j', (query, expected) => {
		expect(normalizeSampleQuery(query)).toBe(expected);
	});
});

describe('datasetNamedBy', () => {
	const datasets = [ptbxl([]), mimic([])];

	it.each([
		['ptbxl-141', 'ptbxl'],
		['PTBXL-00141_hr', 'ptbxl'],
		['PTB-XL 00141_hr', 'ptbxl'],
		['ptbxl-', 'ptbxl'],
		['mimic-iv-ecg-41084804', 'mimic-iv-ecg'],
		['MIMIC-IV-ECG s41084804', 'mimic-iv-ecg'],
		['141', null],
		['s41084804', null],
		['chapman-141', null],
		['ptbxl', null],
		['', null]
	])('takes %j to name %j', (query, expected) => {
		expect(datasetNamedBy(query, datasets)).toBe(expected);
	});
});

describe('searchSamples', () => {
	const { samples } = parseSampleIndex(
		index(
			ptbxl(
				['1410', '14', '141', '2141', '1', '3141', '21410', '1414'].map((id) => [
					id,
					`${id.padStart(5, '0')}_hr`
				])
			)
		)
	).datasets[0];

	const ids = (query: string, limit?: number) =>
		searchSamples(samples, query, limit).matches.map((sample) => sample.ecgId);

	it('lists the exact match, then prefix matches, then substring matches, each in numeric order', () => {
		expect(ids('141')).toEqual(['141', '1410', '1414', '2141', '3141', '21410']);
	});

	it('matches however the query spells the id', () => {
		expect(ids('ptbxl-00141_hr')[0]).toBe('141');
		expect(ids('00014')).toEqual(['14', '141', '1410', '1414', '2141', '3141', '21410']);
	});

	it('counts every match but returns at most the limit', () => {
		expect(searchSamples(samples, '141', 2)).toEqual({
			matches: samples.filter((sample) => ['141', '1410'].includes(sample.ecgId)),
			total: 6,
			exact: samples.find((sample) => sample.ecgId === '141')
		});
	});

	it('names the sample whose id the query is, and no other', () => {
		expect(searchSamples(samples, 'ptbxl-00141_hr').exact?.id).toBe('ptbxl-141');
		// Ids that only start with or contain the query are listed, not taken for it.
		expect(searchSamples(samples, '141', 1).exact?.id).toBe('ptbxl-141');
		expect(searchSamples(samples, '214').exact).toBeNull();
		expect(searchSamples(samples, '214').total).toBe(2);
	});

	it('returns the first samples for an empty query, and names none', () => {
		expect(searchSamples(samples, '  ', 3)).toEqual({
			matches: samples.slice(0, 3),
			total: 8,
			exact: null
		});
		expect(searchSamples(samples, 'ptbxl-').exact).toBeNull();
		expect(searchSamples(samples, '_hr').exact).toBeNull();
	});

	it('finds nothing for an id that is not there', () => {
		expect(searchSamples(samples, '999')).toEqual({ matches: [], total: 0, exact: null });
	});

	it('returns 50 matches by default and scans a few thousand samples quickly', () => {
		const many = parseSampleIndex(
			index(
				mimic(
					Array.from({ length: 3500 }, (_, i) => {
						const id = String(40000000 + i * 37);
						return [id, id];
					})
				)
			)
		).datasets[0].samples;

		const started = performance.now();
		const result = searchSamples(many, '4');
		const elapsed = performance.now() - started;

		expect(result.matches).toHaveLength(50);
		expect(result.total).toBe(3500);
		expect(elapsed).toBeLessThan(50);
	});
});

describe('sampleFileUrl', () => {
	it('names the file after the sample under the base', () => {
		expect(sampleFileUrl('/ecg-samples', 'ptbxl-141', 'hea')).toBe('/ecg-samples/ptbxl-141.hea');
		expect(sampleFileUrl('http://localhost:8090/samples/', 'mimic-iv-ecg-41084804', 'dat')).toBe(
			'http://localhost:8090/samples/mimic-iv-ecg-41084804.dat'
		);
	});
});

describe('resolveSamplesBase', () => {
	it.each([
		['/ecg-samples', '', '/ecg-samples'],
		['/ecg-samples/', '', '/ecg-samples'],
		['/ecg-samples', 'http://localhost:8080', 'http://localhost:8080/ecg-samples'],
		['/ecg-samples', 'https://chat.example/webui/', 'https://chat.example/webui/ecg-samples'],
		['http://localhost:8090/samples/', '', 'http://localhost:8090/samples'],
		['HTTPS://back.example/samples', '/base', 'HTTPS://back.example/samples']
	])('resolves %j under %j to %j', (url, webuiBaseUrl, expected) => {
		expect(resolveSamplesBase(url, webuiBaseUrl)).toBe(expected);
	});

	it.each([
		['a relative path', 'ecg-samples'],
		['the root path', '/'],
		['a protocol-relative address', '//evil.example/samples'],
		['another scheme', 'ftp://host/samples'],
		['a script address', 'javascript:alert(1)'],
		['an empty string', ''],
		['a value that is not a string', 42],
		['no value', undefined]
	])('gives null for %s', (_, url) => {
		expect(resolveSamplesBase(url, '')).toBeNull();
	});
});

describe('agentSamplesUrl', () => {
	const agent = { id: 'ecg-reasoning-agent', ecg_samples_url: 'http://localhost:8090/samples' };
	const preset = { id: 'my-ecg', info: { base_model_id: 'ecg-reasoning-agent' } };
	const other = { id: 'gpt-4o', ecg_samples_url: '/elsewhere' };

	it('gives the address of the agent model', () => {
		expect(agentSamplesUrl([other, agent, preset])).toBe('http://localhost:8090/samples');
	});

	it('gives the default address when only a preset built on the agent is listed', () => {
		expect(agentSamplesUrl([other, preset])).toBe(DEFAULT_SAMPLES_URL);
		expect(DEFAULT_SAMPLES_URL).toBe('/ecg-samples');
	});

	it('gives null for an agent entry without an address', () => {
		expect(agentSamplesUrl([{ id: 'ecg-reasoning-agent' }, preset])).toBeNull();
		expect(agentSamplesUrl([{ ...agent, ecg_samples_url: 42 }])).toBeNull();
	});

	it('takes only the exact agent id, the one the bridge filter hands records to', () => {
		const prefixed = { ...agent, id: 'demo.ecg-reasoning-agent' };
		const prefixedPreset = { id: 'my-ecg', info: { base_model_id: 'demo.ecg-reasoning-agent' } };
		expect(agentSamplesUrl([prefixed, prefixedPreset])).toBeNull();
		expect(agentSamplesUrl([other, { id: 'x', info: null }])).toBeNull();
		expect(agentSamplesUrl([])).toBeNull();
	});
});

const VALID_INDEX = index(ptbxl([['141', '00141_hr']]));

// A fetch stand-in that answers from the given table and records the
// addresses asked for.
const fakeFetch = (routes: Record<string, () => Response>) => {
	const calls: string[] = [];
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		if (init?.signal?.aborted) {
			throw new DOMException('The operation was aborted.', 'AbortError');
		}
		const route = routes[url];
		return route ? route() : new Response('not found', { status: 404 });
	}) as typeof fetch;
	return { fetchFn, calls };
};

describe('loadSampleIndex', () => {
	it('fetches the index once per base', async () => {
		const { fetchFn, calls } = fakeFetch({
			'/once/index.json': () => Response.json(VALID_INDEX)
		});

		const first = await loadSampleIndex('/once', fetchFn);
		const second = await loadSampleIndex('/once', fetchFn);

		expect(second).toBe(first);
		expect(first.datasets[0].samples[0].id).toBe('ptbxl-141');
		expect(calls).toEqual(['/once/index.json']);
	});

	it('forgets a failed load so the next call tries again', async () => {
		let status = 503;
		const { fetchFn, calls } = fakeFetch({
			'/retry/index.json': () =>
				status === 200 ? Response.json(VALID_INDEX) : new Response('busy', { status })
		});

		await expect(loadSampleIndex('/retry', fetchFn)).rejects.toThrow('HTTP 503');
		status = 200;
		await expect(loadSampleIndex('/retry', fetchFn)).resolves.toMatchObject({ version: 1 });
		expect(calls).toHaveLength(2);
	});

	it('refuses a page that is not JSON and an index of the wrong shape', async () => {
		const { fetchFn } = fakeFetch({
			'/html/index.json': () =>
				new Response('<!doctype html><title>Open WebUI</title>', {
					headers: { 'content-type': 'text/html' }
				}),
			'/shape/index.json': () => Response.json({ version: 1, datasets: [{ key: 'a b' }] })
		});

		await expect(loadSampleIndex('/html', fetchFn)).rejects.toThrow('not valid JSON');
		await expect(loadSampleIndex('/shape', fetchFn)).rejects.toThrow(Error);
		await expect(loadSampleIndex('/missing', fetchFn)).rejects.toThrow('HTTP 404');
	});
});

describe('fetchSampleRecord', () => {
	const routes = {
		'/s/ptbxl-141.hea': () => new Response('00141_hr 12 500 5000\n'),
		'/s/ptbxl-141.dat': () => new Response(new Uint8Array([1, 2, 3, 4]))
	};

	it('fetches both files and names them after the stem', async () => {
		const { fetchFn, calls } = fakeFetch(routes);

		const record = await fetchSampleRecord('/s', 'ptbxl-141', '00141_hr', undefined, fetchFn);

		expect(calls.sort()).toEqual(['/s/ptbxl-141.dat', '/s/ptbxl-141.hea']);
		expect(record.stem).toBe('00141_hr');
		expect(record.hea.name).toBe('00141_hr.hea');
		expect(record.dat.name).toBe('00141_hr.dat');
		expect(await record.hea.text()).toBe('00141_hr 12 500 5000\n');
		expect(new Uint8Array(await record.dat.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it('rejects when a file is missing', async () => {
		const { fetchFn } = fakeFetch({ '/s/ptbxl-141.hea': routes['/s/ptbxl-141.hea'] });

		await expect(
			fetchSampleRecord('/s', 'ptbxl-141', '00141_hr', undefined, fetchFn)
		).rejects.toThrow('00141_hr.dat could not be fetched (HTTP 404).');
	});

	it('rejects with an AbortError once the signal aborts', async () => {
		const { fetchFn } = fakeFetch(routes);
		const controller = new AbortController();
		controller.abort();

		await expect(
			fetchSampleRecord('/s', 'ptbxl-141', '00141_hr', controller.signal, fetchFn)
		).rejects.toMatchObject({ name: 'AbortError' });
	});
});
