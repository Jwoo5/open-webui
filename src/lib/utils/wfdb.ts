/**
 * Reading of WFDB records in the browser: the header (.hea) file as far as
 * the chat needs it, the full header grammar, and the samples of a signal
 * (.dat) file in physical units.
 */

/** The 12 standard leads in the order the ECG backend expects them. */
export const CANONICAL_LEADS: readonly string[] = [
	'I',
	'II',
	'III',
	'aVR',
	'aVL',
	'aVF',
	'V1',
	'V2',
	'V3',
	'V4',
	'V5',
	'V6'
];

/** The canonical spelling of a lead name, matched case-insensitively, or null. */
export const canonicalLeadName = (name: string): string | null => {
	const wanted = name.trim().toUpperCase();
	return CANONICAL_LEADS.find((lead) => lead.toUpperCase() === wanted) ?? null;
};

/** Whether the names are exactly the 12 canonical leads, in any order. */
export const isCanonicalLeadSet = (names: readonly string[]): boolean =>
	names.length === CANONICAL_LEADS.length &&
	new Set(names).size === CANONICAL_LEADS.length &&
	names.every((name) => CANONICAL_LEADS.includes(name));

export type WfdbHeader = {
	fs: number | null;
	leads: string[] | null;
};

/** One signal specification line of a header. */
export type WfdbSignalSpec = {
	fileName: string;
	format: number;
	samplesPerFrame: number;
	byteOffset: number;
	skew: number;
	gain: number;
	baseline: number;
	units: string;
	description: string;
};

/** The record line and the signal specification lines of a header. */
export type WfdbRecordHeader = {
	recordName: string;
	nSig: number;
	fs: number;
	nSamples: number | null;
	signals: WfdbSignalSpec[];
};

/** The sampling rate a header without one is taken at, per the WFDB format. */
const DEFAULT_FS = 250;

/** The ADC gain a signal line without one, or with 0, is taken at, per the WFDB format. */
const DEFAULT_GAIN = 200;

const DEFAULT_UNITS = 'mV';

/** The non-empty, non-comment lines of a header, trimmed. */
const headerLines = (text: string): string[] =>
	text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'));

const splitFields = (line: string): string[] => line.split(/\s+/);

/**
 * The sampling rate stated in the third field of a record line, which is
 * `fs[/counter_freq[(counter_base)]]`, or null when the field is absent or
 * does not hold a positive number.
 */
const statedRate = (field: string | undefined): number | null => {
	if (field === undefined) {
		return null;
	}
	const rate = Number.parseFloat(field.split('/')[0]);
	return Number.isFinite(rate) && rate > 0 ? rate : null;
};

/** The description of a signal line: the fields from the ninth onward. */
const signalDescription = (fields: string[]): string => fields.slice(8).join(' ');

const isUnsignedInteger = (field: string | undefined): field is string =>
	field !== undefined && /^\d+$/.test(field);

/**
 * Parses the record line and the signal specification lines of a WFDB header.
 *
 * The record line is `record_name n_sig fs [n_samples ...]`; the next `n_sig`
 * lines describe one signal each, with the description (the lead name) being
 * everything after the eighth field. Comment lines start with `#`. `fs` is
 * null when the record line does not state a positive rate; `leads` is the
 * canonical spelling of the twelve names when the header describes exactly
 * twelve signals that together form the standard 12-lead set, else null.
 */
export const parseWfdbHeader = (text: string): WfdbHeader => {
	const lines = headerLines(text);

	if (lines.length === 0) {
		return { fs: null, leads: null };
	}

	const recordFields = splitFields(lines[0]);
	const nSig = Number.parseInt(recordFields[1] ?? '', 10);
	const fs = statedRate(recordFields[2]);

	if (nSig !== CANONICAL_LEADS.length || lines.length < 1 + nSig) {
		return { fs, leads: null };
	}

	const leads: string[] = [];
	for (const line of lines.slice(1, 1 + nSig)) {
		const lead = canonicalLeadName(signalDescription(splitFields(line)));
		if (lead === null) {
			return { fs, leads: null };
		}
		leads.push(lead);
	}

	return { fs, leads: isCanonicalLeadSet(leads) ? leads : null };
};

/**
 * The number of signals the record line of a header states, or null when
 * the header has no record line or its second field is not a whole number.
 */
export const statedSignalCount = (text: string): number | null => {
	const lines = headerLines(text);
	if (lines.length === 0) {
		return null;
	}
	const field = splitFields(lines[0])[1];
	return isUnsignedInteger(field) ? Number.parseInt(field, 10) : null;
};

/**
 * Whether a record name holds only the characters the ECG server takes in
 * one: letters, digits, `_` and `-`, in any script, as Python reads `[-\w]`.
 */
export const isUsableRecordName = (name: string): boolean => /^[\p{L}\p{N}_-]+$/u.test(name);

/**
 * Parses one signal specification line:
 * `file_name format[xN][:skew][+offset] [adc_gain[(baseline)][/units] [adc_res [adc_zero [init_value [checksum [block_size [description...]]]]]]]`.
 * `x` is followed by the samples per frame, `:` by the skew in samples and
 * `+` by the byte offset of the data in the file. The gain defaults to 200
 * when absent or 0, the units to mV, and the baseline to `adc_zero` (itself
 * 0 when absent) when no `(baseline)` is given.
 */
const parseSignalLine = (line: string, position: number): WfdbSignalSpec => {
	const fields = splitFields(line);
	const formatMatch = /^(\d+)(?:x(\d+))?(?::(\d+))?(?:\+(\d+))?$/.exec(fields[1] ?? '');
	if (fields.length < 2 || formatMatch === null) {
		throw new Error(`Signal line ${position} of the header is malformed.`);
	}

	const gainMatch = /^([^(/]*)(?:\(([-+]?\d+)\))?(?:\/(.*))?$/.exec(fields[2] ?? '');
	const statedGain = Number.parseFloat(gainMatch?.[1] ?? '');
	const adcZero = Number.parseInt(fields[4] ?? '', 10);
	const statedBaseline = Number.parseInt(gainMatch?.[2] ?? '', 10);

	return {
		fileName: fields[0],
		format: Number.parseInt(formatMatch[1], 10),
		samplesPerFrame: Number.parseInt(formatMatch[2] ?? '1', 10),
		skew: Number.parseInt(formatMatch[3] ?? '0', 10),
		byteOffset: Number.parseInt(formatMatch[4] ?? '0', 10),
		gain: Number.isFinite(statedGain) && statedGain !== 0 ? statedGain : DEFAULT_GAIN,
		baseline: Number.isFinite(statedBaseline)
			? statedBaseline
			: Number.isFinite(adcZero)
				? adcZero
				: 0,
		units: gainMatch?.[3] || DEFAULT_UNITS,
		description: signalDescription(fields)
	};
};

/**
 * Parses a WFDB header in full.
 *
 * The record line is
 * `record_name[/n_segments] n_sig [fs[/counter_freq[(counter_base)]] [n_samples [base_time [base_date]]]]`,
 * followed by `n_sig` signal lines (see `parseSignalLine`). Comment lines
 * start with `#`. A header that omits the sampling rate is taken at the
 * format's default of 250 Hz; `nSamples` is null when the record line omits
 * the number or states 0, which the format uses for an unknown length.
 * Throws an Error on a malformed record line, a multi-segment record
 * (`record_name/n_segments`), a missing or malformed signal line, or a
 * sampling rate that is not positive.
 */
export const parseWfdbRecordHeader = (text: string): WfdbRecordHeader => {
	const lines = headerLines(text);
	if (lines.length === 0) {
		throw new Error('The header has no record line.');
	}

	const recordFields = splitFields(lines[0]);
	// The lines of a multi-segment record name segments, not signals.
	if (recordFields[0].includes('/')) {
		throw new Error('Multi-segment records are not supported.');
	}
	const recordName = recordFields[0];
	if (recordName === '' || !isUnsignedInteger(recordFields[1])) {
		throw new Error('The record line of the header is malformed.');
	}
	const nSig = Number.parseInt(recordFields[1], 10);

	let fs = DEFAULT_FS;
	if (recordFields[2] !== undefined) {
		const rate = statedRate(recordFields[2]);
		if (rate === null) {
			throw new Error('The header does not state a positive sampling rate.');
		}
		fs = rate;
	}

	let nSamples: number | null = null;
	if (recordFields[3] !== undefined) {
		if (!isUnsignedInteger(recordFields[3])) {
			throw new Error('The record line of the header is malformed.');
		}
		const count = Number.parseInt(recordFields[3], 10);
		nSamples = count > 0 ? count : null;
	}

	if (lines.length < 1 + nSig) {
		throw new Error(
			`The header names ${nSig} signals but has only ${lines.length - 1} signal lines.`
		);
	}

	const signals = lines.slice(1, 1 + nSig).map((line, index) => parseSignalLine(line, index + 1));

	return { recordName, nSig, fs, nSamples, signals };
};

/** Bytes per sample of the supported signal formats. */
const BYTES_PER_SAMPLE: Record<number, number> = {
	16: 2,
	61: 2,
	80: 1,
	24: 3,
	32: 4,
	212: 1.5
};

/**
 * The raw value a format stores for a sample that is missing, which is read
 * as NaN so that a plot leaves a gap instead of drawing a spike.
 */
const INVALID_SAMPLE: Record<number, number> = {
	16: -32768,
	61: -32768,
	80: -128,
	24: -8388608,
	32: -2147483648,
	212: -2048
};

/** A reader of the raw value of the k-th sample of the data stream. */
const rawSampleReader = (
	format: number,
	view: DataView,
	byteOffset: number
): ((index: number) => number) => {
	switch (format) {
		case 16:
			return (index) => view.getInt16(byteOffset + 2 * index, true);
		case 61:
			return (index) => view.getInt16(byteOffset + 2 * index, false);
		case 80:
			return (index) => view.getUint8(byteOffset + index) - 128;
		case 24:
			return (index) => {
				const position = byteOffset + 3 * index;
				const value =
					view.getUint8(position) |
					(view.getUint8(position + 1) << 8) |
					(view.getUint8(position + 2) << 16);
				return value & 0x800000 ? value - 0x1000000 : value;
			};
		case 32:
			return (index) => view.getInt32(byteOffset + 4 * index, true);
		case 212:
			// Two 12-bit two's-complement samples share three bytes: the low
			// byte of each is its own, and the middle byte holds the high
			// nibbles, the first sample's in its low half.
			return (index) => {
				const position = byteOffset + 3 * Math.floor(index / 2);
				const middle = view.getUint8(position + 1);
				const value =
					index % 2 === 0
						? view.getUint8(position) | ((middle & 0x0f) << 8)
						: view.getUint8(position + 2) | ((middle & 0xf0) << 4);
				return value & 0x800 ? value - 0x1000 : value;
			};
		default:
			throw new Error(`Signal format ${format} is not supported.`);
	}
};

/**
 * Reads the samples of every signal of the record from the data of its one
 * signal file, in millivolts: `(raw - baseline) / gain`, divided by 1000
 * more when the signal's units are uV. A sample stored as the format's
 * missing-sample value comes out as NaN. Samples are interleaved by frame,
 * and the number of frames is the header's `nSamples` when it states one,
 * else what the data holds after the byte offset, never more than the data
 * allows. Throws an Error for a format other than 16, 61, 80, 24, 32 and
 * 212, for signals spread over more than one file or stating different
 * formats or byte offsets, for more than one sample per frame, and for a
 * skew.
 */
export const readWfdbSignals = (header: WfdbRecordHeader, data: ArrayBuffer): Float32Array[] => {
	const { signals } = header;
	const nSig = signals.length;
	if (nSig === 0) {
		return [];
	}

	const [first] = signals;
	if (signals.some((signal) => signal.fileName !== first.fileName)) {
		throw new Error('The signals are stored in more than one file.');
	}
	if (signals.some((signal) => signal.format !== first.format)) {
		throw new Error('The signals are stored in more than one format.');
	}
	if (signals.some((signal) => signal.byteOffset !== first.byteOffset)) {
		throw new Error('The signals state different byte offsets.');
	}
	if (signals.some((signal) => signal.samplesPerFrame !== 1)) {
		throw new Error('More than one sample per frame is not supported.');
	}
	if (signals.some((signal) => signal.skew !== 0)) {
		throw new Error('A skew between signals is not supported.');
	}

	const { format, byteOffset } = first;
	const bytesPerSample = BYTES_PER_SAMPLE[format];
	if (bytesPerSample === undefined) {
		throw new Error(`Signal format ${format} is not supported.`);
	}

	const view = new DataView(data);
	const readRaw = rawSampleReader(format, view, byteOffset);
	const invalid = INVALID_SAMPLE[format];

	const availableBytes = Math.max(0, data.byteLength - byteOffset);
	const availableFrames = Math.floor(Math.floor(availableBytes / bytesPerSample) / nSig);
	const nFrames = Math.min(header.nSamples ?? availableFrames, availableFrames);

	const scales = signals.map((signal) => {
		const gain = signal.units.toLowerCase() === 'uv' ? signal.gain * 1000 : signal.gain;
		return { baseline: signal.baseline, gain };
	});

	const result = signals.map(() => new Float32Array(nFrames));
	for (let frame = 0; frame < nFrames; frame += 1) {
		for (let channel = 0; channel < nSig; channel += 1) {
			const raw = readRaw(frame * nSig + channel);
			result[channel][frame] =
				raw === invalid ? NaN : (raw - scales[channel].baseline) / scales[channel].gain;
		}
	}

	return result;
};
