import { describe, expect, it } from 'vitest';
import {
	ecgItemCount,
	ecgRecordOf,
	ecgSendBlocker,
	exceedsFileLimit,
	groupAttachments,
	hasEcgAttachment,
	nextQueuedBatch,
	withoutEcgRecord
} from './ecgAttachments';

type Item = Record<string, unknown>;

// The three items a recording is attached as, in the order they are attached.
const preview = (record: string, extra: Item = {}): Item => ({
	name: `${record}.png`,
	status: 'uploaded',
	ecg_role: 'preview',
	ecg_record: record,
	...extra
});
const signal = (record: string, extra: Item = {}): Item => ({
	name: `${record}.dat`,
	status: 'uploaded',
	context: 'full',
	ecg_role: 'signal',
	ecg_record: record,
	...extra
});
const header = (record: string, extra: Item = {}): Item => ({
	name: `${record}.hea`,
	status: 'uploaded',
	context: 'full',
	ecg_role: 'header',
	ecg_record: record,
	...extra
});
const record = (stem: string, extra: Item = {}): Item[] => [
	preview(stem, extra),
	signal(stem, extra),
	header(stem, extra)
];

// What every item of a benchmark sample carries, and the two items a sample
// is attached as: its preview and its .hea, without its .dat.
const picked = { ecg_sample: 'ptbxl-13665', ecg_label: 'PTB-XL 13665' };
const sampleRecord = (stem: string, extra: Item = {}): Item[] => [
	preview(stem, { ...picked, ...extra }),
	header(stem, { ...picked, ...extra })
];

const notes: Item = { name: 'notes.pdf', type: 'file', status: 'uploaded' };
const photo: Item = { name: 'photo.png', type: 'image', status: 'uploaded' };

describe('ecgRecordOf', () => {
	it('names the record of an item with a role and a record name', () => {
		expect(ecgRecordOf(preview('00141_hr'))).toBe('00141_hr');
		expect(ecgRecordOf(signal('41084804'))).toBe('41084804');
	});

	it('names no record for any other item', () => {
		expect(ecgRecordOf(notes)).toBeNull();
		expect(ecgRecordOf({ ecg_record: '00141_hr' })).toBeNull();
		expect(ecgRecordOf({ ecg_role: 'signal' })).toBeNull();
		expect(ecgRecordOf({ ecg_role: 'signal', ecg_record: '' })).toBeNull();
		expect(ecgRecordOf({ ecg_role: 'signal', ecg_record: 141 })).toBeNull();
		expect(ecgRecordOf({ ecg_role: 1, ecg_record: '00141_hr' })).toBeNull();
		expect(ecgRecordOf(null)).toBeNull();
		expect(ecgRecordOf(undefined)).toBeNull();
		expect(ecgRecordOf('00141_hr')).toBeNull();
	});
});

describe('groupAttachments', () => {
	it('shows a record once, at the position of its first item, between the files around it', () => {
		const files = [notes, ...record('00141_hr'), photo];
		const entries = groupAttachments(files);

		expect(entries.map((entry) => entry.kind)).toEqual(['file', 'ecg', 'file']);
		expect(entries[0]).toEqual({ kind: 'file', item: notes, index: 0 });
		expect(entries[2]).toEqual({ kind: 'file', item: photo, index: 4 });
		expect(entries[1]).toEqual({
			kind: 'ecg',
			record: '00141_hr',
			items: files.slice(1, 4),
			indices: [1, 2, 3],
			preview: files[1],
			label: '00141_hr',
			sample: null,
			pacemakerDetection: false,
			uploading: false,
			complete: true
		});
	});

	it('keeps the position of every item of a record in the files', () => {
		const [png, dat, hea] = record('00141_hr');
		const entries = groupAttachments([png, notes, dat, photo, hea]);

		expect(entries.map((entry) => entry.kind)).toEqual(['ecg', 'file', 'file']);
		expect(entries[0]).toMatchObject({ items: [png, dat, hea], indices: [0, 2, 4] });
		expect(entries[1]).toMatchObject({ item: notes, index: 1 });
		expect(entries[2]).toMatchObject({ item: photo, index: 3 });
	});

	it('leaves the files that belong to no record as they are, in their places', () => {
		const loose = { name: 'loose.dat', ecg_record: '00141_hr' };
		const files = [notes, photo, loose];

		expect(groupAttachments(files)).toEqual([
			{ kind: 'file', item: notes, index: 0 },
			{ kind: 'file', item: photo, index: 1 },
			{ kind: 'file', item: loose, index: 2 }
		]);
		expect(groupAttachments([])).toEqual([]);
	});

	it('shows a record without a preview, as one is attached when none could be drawn', () => {
		const files = [signal('00141_hr'), header('00141_hr')];
		const [entry] = groupAttachments(files);

		expect(entry).toMatchObject({
			kind: 'ecg',
			indices: [0, 1],
			preview: null,
			complete: true
		});
	});

	it('marks a record with an item still being uploaded', () => {
		const files = [preview('00141_hr'), signal('00141_hr', { status: 'uploading' })];
		const [entry] = groupAttachments(files);

		expect(entry).toMatchObject({ uploading: true, complete: false });
		expect(groupAttachments([preview('00141_hr', { status: 'uploading' })])[0]).toMatchObject({
			uploading: true,
			complete: false
		});
	});

	it('calls a recording complete only with both its .dat and its .hea', () => {
		expect(groupAttachments([preview('a'), signal('a')])[0]).toMatchObject({ complete: false });
		expect(groupAttachments([preview('a'), header('a')])[0]).toMatchObject({ complete: false });
		expect(groupAttachments([header('a'), signal('a')])[0]).toMatchObject({ complete: true });
	});

	it('calls a sample complete with its .hea, which carries it without the .dat', () => {
		const files = sampleRecord('13665_hr');
		expect(groupAttachments(files)[0]).toEqual({
			kind: 'ecg',
			record: '13665_hr',
			items: files,
			indices: [0, 1],
			preview: files[0],
			label: 'PTB-XL 13665',
			sample: 'ptbxl-13665',
			pacemakerDetection: false,
			uploading: false,
			complete: true
		});

		// A sample whose preview could not be drawn is attached as its .hea alone.
		expect(groupAttachments([header('13665_hr', picked)])[0]).toMatchObject({
			preview: null,
			sample: 'ptbxl-13665',
			complete: true
		});
	});

	it('calls a sample without its .hea incomplete, with or without its .dat', () => {
		expect(groupAttachments([preview('13665_hr', picked)])[0]).toMatchObject({
			sample: 'ptbxl-13665',
			complete: false
		});
		expect(
			groupAttachments([preview('13665_hr', picked), signal('13665_hr', picked)])[0]
		).toMatchObject({ sample: 'ptbxl-13665', complete: false });
	});

	it('still calls a sample of an older message, attached with its .dat, complete', () => {
		const files = [notes, ...record('13665_hr', picked)];
		const [, entry] = groupAttachments(files);

		expect(entry).toMatchObject({
			kind: 'ecg',
			items: files.slice(1),
			indices: [1, 2, 3],
			preview: files[1],
			label: 'PTB-XL 13665',
			sample: 'ptbxl-13665',
			complete: true
		});
	});

	it('names the sample a record was picked as from any of its items', () => {
		const partly = [preview('13665_hr'), header('13665_hr', { ecg_sample: 'ptbxl-13665' })];
		expect(groupAttachments(partly)[0]).toMatchObject({ sample: 'ptbxl-13665', complete: true });

		expect(groupAttachments(record('00141_hr'))[0]).toMatchObject({ sample: null });
		for (const ecg_sample of ['', 13665, null]) {
			expect(
				groupAttachments([preview('00141_hr'), header('00141_hr', { ecg_sample })])[0]
			).toMatchObject({ sample: null, complete: false });
		}
	});

	it('marks a sample with its .hea still being uploaded', () => {
		const files = [
			preview('13665_hr', picked),
			header('13665_hr', { ...picked, status: 'uploading' })
		];
		expect(groupAttachments(files)[0]).toMatchObject({ uploading: true, complete: true });
	});

	it('shows each record of an older message that holds several on its own', () => {
		const files = [...record('00141_hr'), notes, ...record('13665_hr')];
		const entries = groupAttachments(files);

		expect(entries.map((entry) => entry.kind)).toEqual(['ecg', 'file', 'ecg']);
		expect(entries[0]).toMatchObject({ record: '00141_hr', indices: [0, 1, 2] });
		expect(entries[1]).toMatchObject({ item: notes, index: 3 });
		expect(entries[2]).toMatchObject({ record: '13665_hr', indices: [4, 5, 6] });
	});

	it('labels a record by its items, or by the record name when they carry no label', () => {
		const labeled = record('13665_hr', { ecg_label: 'PTB-XL 13665', ecg_sample: 'ptbxl-13665' });
		expect(groupAttachments(labeled)[0]).toMatchObject({ label: 'PTB-XL 13665' });

		const partly = [
			preview('41084804'),
			signal('41084804', { ecg_label: 'MIMIC-IV-ECG 41084804' })
		];
		expect(groupAttachments(partly)[0]).toMatchObject({ label: 'MIMIC-IV-ECG 41084804' });

		expect(groupAttachments(record('00141_hr'))[0]).toMatchObject({ label: '00141_hr' });
		expect(groupAttachments(record('00141_hr', { ecg_label: ' ' }))[0]).toMatchObject({
			label: '00141_hr'
		});
		expect(groupAttachments(record('00141_hr', { ecg_label: 141 }))[0]).toMatchObject({
			label: '00141_hr'
		});
	});

	it('reads whether pacemaker detection is on for a record from its items', () => {
		const set = (ecg_pacemaker_detection: unknown) =>
			groupAttachments(record('00141_hr', { ecg_pacemaker_detection }))[0];

		expect(set(true)).toMatchObject({ pacemakerDetection: true });
		expect(set(false)).toMatchObject({ pacemakerDetection: false });
		expect(
			groupAttachments(sampleRecord('13665_hr', { ecg_pacemaker_detection: true }))[0]
		).toMatchObject({
			sample: 'ptbxl-13665',
			pacemakerDetection: true,
			complete: true
		});
	});

	it('reads a record attached without the setting as having detection off', () => {
		expect(groupAttachments(record('00141_hr'))[0]).toMatchObject({ pacemakerDetection: false });
		expect(groupAttachments(sampleRecord('13665_hr'))[0]).toMatchObject({
			pacemakerDetection: false
		});
	});

	it('reads any value but true as off', () => {
		for (const ecg_pacemaker_detection of [null, 1, 'true', 'on', [true], { on: true }]) {
			expect(groupAttachments(record('00141_hr', { ecg_pacemaker_detection }))[0]).toMatchObject({
				pacemakerDetection: false
			});
		}
	});

	it('does not read the paced-beat statement of an earlier attach dialog', () => {
		const [entry] = groupAttachments(record('00141_hr', { ecg_paced: ['ventricular'] }));
		expect(entry).toMatchObject({ pacemakerDetection: false });
		expect(entry).not.toHaveProperty('paced');
	});

	it('takes the setting from the .hea first, then the .dat, then the preview, as the filter does', () => {
		const mixed = [
			preview('00141_hr', { ecg_pacemaker_detection: true }),
			signal('00141_hr', { ecg_pacemaker_detection: true }),
			header('00141_hr', { ecg_pacemaker_detection: false })
		];
		expect(groupAttachments(mixed)[0]).toMatchObject({ pacemakerDetection: false });

		const withoutHeader = [
			preview('00141_hr', { ecg_pacemaker_detection: false }),
			signal('00141_hr', { ecg_pacemaker_detection: true })
		];
		expect(groupAttachments(withoutHeader)[0]).toMatchObject({ pacemakerDetection: true });

		const previewOnly = [preview('00141_hr', { ecg_pacemaker_detection: true })];
		expect(groupAttachments(previewOnly)[0]).toMatchObject({ pacemakerDetection: true });

		// An item of the role without the setting reads as off, whatever the others carry.
		const headerWithout = [
			signal('00141_hr', { ecg_pacemaker_detection: true }),
			header('00141_hr')
		];
		expect(groupAttachments(headerWithout)[0]).toMatchObject({ pacemakerDetection: false });
	});

	it('takes the setting from the item of a role attached last', () => {
		const twice = [
			header('00141_hr', { ecg_pacemaker_detection: true }),
			header('00141_hr', { ecg_pacemaker_detection: false })
		];
		expect(groupAttachments(twice)[0]).toMatchObject({ pacemakerDetection: false });
	});

	it('keeps the setting of each record of an older message to that record', () => {
		const files = [
			...record('00141_hr', { ecg_pacemaker_detection: true }),
			...sampleRecord('13665_hr')
		];
		const [first, second] = groupAttachments(files);

		expect(first).toMatchObject({ record: '00141_hr', pacemakerDetection: true });
		expect(second).toMatchObject({ record: '13665_hr', pacemakerDetection: false });
	});
});

describe('withoutEcgRecord', () => {
	it('drops every item of the record and keeps the rest in order', () => {
		const files = [notes, ...record('00141_hr'), photo, ...record('13665_hr')];

		expect(withoutEcgRecord(files, '00141_hr')).toEqual([notes, photo, ...record('13665_hr')]);
		expect(withoutEcgRecord(files, '13665_hr')).toEqual([notes, ...record('00141_hr'), photo]);
	});

	it('keeps items that only carry the record name, and leaves the files unchanged', () => {
		const loose = { name: 'loose.dat', ecg_record: '00141_hr' };
		const files = [loose, ...record('00141_hr')];

		expect(withoutEcgRecord(files, '00141_hr')).toEqual([loose]);
		expect(files).toHaveLength(4);
		expect(withoutEcgRecord(files, 'other')).toEqual(files);
	});
});

describe('hasEcgAttachment', () => {
	it('is true once an item of a record is among the files', () => {
		expect(hasEcgAttachment([notes, preview('00141_hr', { status: 'uploading' })])).toBe(true);
		expect(hasEcgAttachment(record('00141_hr'))).toBe(true);
	});

	it('is false for files that belong to no record', () => {
		expect(hasEcgAttachment([])).toBe(false);
		expect(hasEcgAttachment([notes, photo, { name: 'loose.dat', ecg_record: '00141_hr' }])).toBe(
			false
		);
		expect(hasEcgAttachment([null, undefined])).toBe(false);
	});
});

describe('ecgSendBlocker', () => {
	it('lets a message with a complete record, or with none, be sent', () => {
		expect(ecgSendBlocker([notes, ...record('00141_hr')])).toBeNull();
		expect(ecgSendBlocker([signal('00141_hr'), header('00141_hr')])).toBeNull();
		expect(ecgSendBlocker([notes, ...sampleRecord('13665_hr')])).toBeNull();
		expect(ecgSendBlocker([header('13665_hr', picked)])).toBeNull();
		expect(ecgSendBlocker(record('13665_hr', picked))).toBeNull();
		expect(ecgSendBlocker([notes, photo, { name: 'loose.dat', ecg_record: 'a' }])).toBeNull();
		expect(ecgSendBlocker([])).toBeNull();
	});

	it('holds a message while a record is being attached', () => {
		expect(ecgSendBlocker([], true)).toBe('attaching');
		expect(ecgSendBlocker(record('00141_hr'), true)).toBe('attaching');
		expect(ecgSendBlocker([preview('00141_hr'), signal('00141_hr', { status: 'uploading' })])).toBe(
			'attaching'
		);
		expect(
			ecgSendBlocker([
				preview('00141_hr'),
				signal('00141_hr'),
				header('00141_hr', { status: 'uploading' })
			])
		).toBe('attaching');
		expect(ecgSendBlocker(sampleRecord('13665_hr'), true)).toBe('attaching');
		expect(ecgSendBlocker([preview('13665_hr', { ...picked, status: 'uploading' })])).toBe(
			'attaching'
		);
		expect(
			ecgSendBlocker([
				preview('13665_hr', picked),
				header('13665_hr', { ...picked, status: 'uploading' })
			])
		).toBe('attaching');
	});

	it('holds a message with a recording that lacks its .dat or its .hea', () => {
		expect(ecgSendBlocker([preview('00141_hr')])).toBe('incomplete');
		expect(ecgSendBlocker([preview('00141_hr'), signal('00141_hr')])).toBe('incomplete');
		expect(ecgSendBlocker([preview('00141_hr'), header('00141_hr')])).toBe('incomplete');
		expect(ecgSendBlocker([...record('00141_hr'), header('13665_hr')])).toBe('incomplete');
	});

	it('holds a message with a sample that lacks its .hea', () => {
		expect(ecgSendBlocker([preview('13665_hr', picked)])).toBe('incomplete');
		expect(ecgSendBlocker([preview('13665_hr', picked), signal('13665_hr', picked)])).toBe(
			'incomplete'
		);
		expect(ecgSendBlocker([...sampleRecord('13665_hr'), preview('00141_hr', picked)])).toBe(
			'incomplete'
		);
	});

	it('does not hold a message for a file of its own still uploading', () => {
		expect(ecgSendBlocker([...record('00141_hr'), { ...notes, status: 'uploading' }])).toBeNull();
	});
});

describe('ecgItemCount', () => {
	it('counts the preview and the .hea of a sample, and the .dat of a recording as well', () => {
		expect(ecgItemCount('sample')).toBe(sampleRecord('13665_hr').length);
		expect(ecgItemCount('recording')).toBe(record('00141_hr').length);
	});

	it('counts the fewest items any source adds before the source is chosen', () => {
		expect(ecgItemCount(null)).toBe(Math.min(ecgItemCount('sample'), ecgItemCount('recording')));
	});
});

describe('exceedsFileLimit', () => {
	it('never refuses a record without a limit', () => {
		expect(exceedsFileLimit(100, 100, null, 'recording')).toBe(false);
		expect(exceedsFileLimit(100, 100, null, null)).toBe(false);
	});

	it('lets a sample fit where a recording, with its .dat, does not', () => {
		expect(exceedsFileLimit(3, 0, 5, 'sample')).toBe(false);
		expect(exceedsFileLimit(3, 0, 5, 'recording')).toBe(true);
		expect(exceedsFileLimit(2, 0, 5, 'recording')).toBe(false);
	});

	it('refuses before the source is chosen only what no source could attach', () => {
		expect(exceedsFileLimit(3, 0, 5, null)).toBe(false);
		expect(exceedsFileLimit(4, 0, 5, null)).toBe(true);
		expect(exceedsFileLimit(4, 0, 5, 'sample')).toBe(true);
		expect(exceedsFileLimit(0, 0, 1, null)).toBe(true);
	});

	it('counts the files the chat holds, which the message is sent with', () => {
		// A chat that holds a recording's .dat and .hea and a sample's .hea,
		// under a limit of four: a sample fits an empty message alone, but the
		// message could not be sent with the chat's three files.
		const chatFiles = [signal('00141_hr'), header('00141_hr'), header('13665_hr', picked)];
		expect(exceedsFileLimit(0, 0, 4, 'sample')).toBe(false);
		expect(exceedsFileLimit(0, chatFiles.length, 4, 'sample')).toBe(true);
		expect(exceedsFileLimit(0, chatFiles.length, 4, null)).toBe(true);
		expect(exceedsFileLimit(0, 2, 4, 'sample')).toBe(false);
		expect(exceedsFileLimit(0, 2, 4, 'recording')).toBe(true);
		expect(exceedsFileLimit(1, 1, 4, 'sample')).toBe(false);
		expect(exceedsFileLimit(1, 2, 4, 'sample')).toBe(true);
	});
});

describe('nextQueuedBatch', () => {
	const message = (id: string, files?: Item[] | null) => ({ id, prompt: id, files });

	it('sends every queued message together when at most the first carries a record', () => {
		const queue = [message('a', record('00141_hr')), message('b', [notes]), message('c')];
		expect(nextQueuedBatch(queue)).toEqual(queue);

		const plain = [message('a', []), message('b', [photo]), message('c', null)];
		expect(nextQueuedBatch(plain)).toEqual(plain);
		expect(nextQueuedBatch([])).toEqual([]);
	});

	it('stops before the next message that carries a record', () => {
		const first = message('a', record('00141_hr'));
		const follow = message('b', [notes]);
		const second = message('c', record('13665_hr'));
		const last = message('d');
		const queue = [first, follow, second, last];

		expect(nextQueuedBatch(queue)).toEqual([first, follow]);
		expect(nextQueuedBatch(queue.slice(2))).toEqual([second, last]);
	});

	it('keeps questions queued before a record out of its message', () => {
		const before = message('a', [notes]);
		const attached = message('b', [signal('00141_hr', { status: 'uploading' })]);
		expect(nextQueuedBatch([before, attached])).toEqual([before]);
		expect(nextQueuedBatch([attached])).toEqual([attached]);
	});

	it('sends one message alone when the next carries the same record again', () => {
		const queue = [message('a', record('00141_hr')), message('b', record('00141_hr'))];
		expect(nextQueuedBatch(queue)).toEqual([queue[0]]);
	});

	it('stops before a sample attached without its .dat as before any record', () => {
		const first = message('a', [notes]);
		const second = message('b', sampleRecord('13665_hr'));
		expect(nextQueuedBatch([first, second])).toEqual([first]);
	});
});
