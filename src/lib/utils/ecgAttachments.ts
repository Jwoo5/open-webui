/**
 * The ECG records among the files of a message. A record is attached as
 * several file items that share its record name (its preview picture, its
 * .hea and, for a recording of the user's own, its .dat), and is shown and
 * removed as one attachment.
 */

/** A file item standing alone, at `index` in the list it was read from. */
export type FileAttachment<T> = { kind: 'file'; item: T; index: number };

/** The items of one ECG record, in the order of the list they were read from. */
export type EcgAttachment<T> = {
	kind: 'ecg';
	/** The WFDB record name the items share. */
	record: string;
	items: T[];
	/** The position of each item in the list it was read from. */
	indices: number[];
	/** The preview picture's item, or null when the record has none. */
	preview: T | null;
	/** The name the record is shown under: its label, or the record name. */
	label: string;
	/** The id of the benchmark sample the record was picked as, or null for a recording. */
	sample: string | null;
	/** Whether the record's analysis runs pacemaker detection. */
	pacemakerDetection: boolean;
	/** Whether an item is still being uploaded. */
	uploading: boolean;
	/**
	 * Whether the items carry what the server needs to read the record: the
	 * .hea of a sample, which names the sample the server reads from its own
	 * copy, or both the .dat and the .hea of a recording.
	 */
	complete: boolean;
};

export type Attachment<T> = FileAttachment<T> | EcgAttachment<T>;

/** Where a record comes from: a benchmark sample, or a recording of the user's own. */
export type EcgSource = 'sample' | 'recording';

/**
 * The roles whose item a record's `ecg_pacemaker_detection` is read from, in
 * turn, as the bridge filter reads it: the .hea first, since a recording and
 * a sample both attach one.
 */
const PACEMAKER_DETECTION_ROLES = ['header', 'signal', 'preview'];

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

const roleOf = (item: unknown): unknown => (isObject(item) ? item.ecg_role : undefined);

/**
 * The name of the ECG record an item belongs to: its `ecg_record` when it
 * has an `ecg_role` and a record name, or null for any other item.
 */
export const ecgRecordOf = (item: unknown): string | null => {
	if (!isObject(item) || typeof item.ecg_role !== 'string') {
		return null;
	}
	const record = item.ecg_record;
	return typeof record === 'string' && record !== '' ? record : null;
};

/** The first non-empty `ecg_label` among the items, or the record name. */
const labelOf = (items: readonly unknown[], record: string): string => {
	for (const item of items) {
		const label = isObject(item) ? item.ecg_label : undefined;
		if (typeof label === 'string' && label.trim() !== '') {
			return label;
		}
	}
	return record;
};

/** The first non-empty `ecg_sample` among the items, or null when none carries one. */
const sampleOf = (items: readonly unknown[]): string | null => {
	for (const item of items) {
		const sample = isObject(item) ? item.ecg_sample : undefined;
		if (typeof sample === 'string' && sample !== '') {
			return sample;
		}
	}
	return null;
};

/**
 * Whether pacemaker detection is on for a record: read off the last item of
 * the first role in PACEMAKER_DETECTION_ROLES the record has, and on only
 * when that item's `ecg_pacemaker_detection` is true. A record attached
 * without the setting has it off.
 */
const pacemakerDetectionOf = (items: readonly unknown[]): boolean => {
	for (const role of PACEMAKER_DETECTION_ROLES) {
		const ofRole = items.filter((item) => roleOf(item) === role);
		if (ofRole.length > 0) {
			const item = ofRole[ofRole.length - 1];
			return isObject(item) && item.ecg_pacemaker_detection === true;
		}
	}
	return false;
};

/**
 * The files as they are shown: each item that belongs to no ECG record as
 * it is, and each ECG record once, at the position of its first item, with
 * all of its items. Every entry keeps the positions of its items in `files`.
 * The entries hold items of the type the files are given in, `any` for an
 * untyped list included.
 */
export const groupAttachments = <F extends readonly unknown[]>(
	files: F
): Attachment<F[number]>[] => {
	type T = F[number];
	const entries: Attachment<T>[] = [];
	const records = new Map<string, EcgAttachment<T>>();

	files.forEach((item: T, index) => {
		const record = ecgRecordOf(item);
		if (record === null) {
			entries.push({ kind: 'file', item, index });
			return;
		}
		let entry = records.get(record);
		if (entry === undefined) {
			entry = {
				kind: 'ecg',
				record,
				items: [],
				indices: [],
				preview: null,
				label: record,
				sample: null,
				pacemakerDetection: false,
				uploading: false,
				complete: false
			};
			records.set(record, entry);
			entries.push(entry);
		}
		entry.items.push(item);
		entry.indices.push(index);
	});

	for (const entry of records.values()) {
		const roles = entry.items.map(roleOf);
		entry.preview = entry.items.find((item) => roleOf(item) === 'preview') ?? null;
		entry.label = labelOf(entry.items, entry.record);
		entry.sample = sampleOf(entry.items);
		entry.pacemakerDetection = pacemakerDetectionOf(entry.items);
		entry.uploading = entry.items.some((item) => isObject(item) && item.status === 'uploading');
		// A sample's .dat is not uploaded, and one an older message holds is
		// not read.
		entry.complete =
			roles.includes('header') && (entry.sample !== null || roles.includes('signal'));
	}

	return entries;
};

/** The files without any item of the ECG record. */
export const withoutEcgRecord = <F extends readonly unknown[]>(
	files: F,
	record: string
): F[number][] => files.filter((item) => ecgRecordOf(item) !== record);

/** Whether an item of the files belongs to an ECG record. */
export const hasEcgAttachment = (files: readonly unknown[]): boolean =>
	files.some((item) => ecgRecordOf(item) !== null);

/**
 * The most file items attaching a record from `source` adds: a sample its
 * preview and its .hea, a recording its .dat as well. With no source, the
 * fewest any source adds, so that a check made before the source is chosen
 * refuses only what no source could attach.
 */
export const ecgItemCount = (source: EcgSource | null): number => (source === 'recording' ? 3 : 2);

/**
 * Whether attaching a record from `source` to a message holding `fileCount`
 * files would take it past `maxCount`, the most files a message may be sent
 * with (null when there is no such limit). A message is sent with the files
 * the chat holds from its earlier messages as well, `chatFileCount` of them,
 * and the check made when it is sent counts them beside its own, so they
 * are counted here too: a record that fits the message alone could not be
 * sent with it.
 */
export const exceedsFileLimit = (
	fileCount: number,
	chatFileCount: number,
	maxCount: number | null,
	source: EcgSource | null
): boolean => maxCount !== null && fileCount + chatFileCount + ecgItemCount(source) > maxCount;

/**
 * Why a message with the files cannot be sent yet: 'attaching' while an
 * ECG record is still being attached (`attaching`, or an item of a record
 * still uploading), 'incomplete' when a record lacks an item the server
 * needs to read it (the .hea of a sample, the .dat or the .hea of a
 * recording), or null when it can be sent.
 */
export const ecgSendBlocker = (
	files: readonly unknown[],
	attaching = false
): 'attaching' | 'incomplete' | null => {
	const records = groupAttachments(files).filter(
		(entry): entry is EcgAttachment<unknown> => entry.kind === 'ecg'
	);
	if (attaching || records.some((entry) => entry.uploading)) {
		return 'attaching';
	}
	return records.some((entry) => !entry.complete) ? 'incomplete' : null;
};

/**
 * The queued messages to send together as one: the first, and those after
 * it up to the next that carries an ECG record. Each record then goes out
 * in a message of its own, with the questions queued after it, and never
 * in a message with another record or with questions queued before it.
 */
export const nextQueuedBatch = <M extends { files?: readonly unknown[] | null }>(
	queue: readonly M[]
): M[] => {
	const end = queue.findIndex(
		(message, index) => index > 0 && hasEcgAttachment(message.files ?? [])
	);
	return queue.slice(0, end === -1 ? queue.length : end);
};
