import { describe, expect, it } from 'vitest';
import {
	isUsableRecordName,
	parseWfdbHeader,
	parseWfdbRecordHeader,
	readWfdbSignals,
	statedSignalCount
} from './wfdb';
import type { WfdbRecordHeader, WfdbSignalSpec } from './wfdb';

const signalLine = (file: string, gain: string, lead: string) =>
	`${file} 16 ${gain}(0)/mV 16 0 -119 -1263 0 ${lead}`;

describe('parseWfdbHeader', () => {
	it('reads a PTB-XL header with upper-case augmented leads', () => {
		const names = ['I', 'II', 'III', 'AVR', 'AVL', 'AVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
		const text = [
			'00001_hr 12 500 5000',
			...names.map((lead) => signalLine('00001_hr.dat', '1000.0', lead))
		].join('\n');

		expect(parseWfdbHeader(text)).toEqual({
			fs: 500,
			leads: ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6']
		});
	});

	it('keeps the aVF/aVL order of a MIMIC-IV-ECG header', () => {
		const names = ['I', 'II', 'III', 'aVR', 'aVF', 'aVL', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
		const text = [
			'40689238 12 500 5000  ',
			'# a comment line',
			...names.map((lead) => signalLine('40689238.dat', '200.0', lead).replace(/ /g, '  ')),
			''
		].join('\r\n');

		expect(parseWfdbHeader(text)).toEqual({
			fs: 500,
			leads: ['I', 'II', 'III', 'aVR', 'aVF', 'aVL', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6']
		});
	});

	it('parses the rate but no leads when the names are not leads', () => {
		const text = [
			'100 2 360 650000',
			'100.dat 212 200 11 1024 995 -22131 0 MLII',
			'100.dat 212 200 11 1024 1011 20052 0 V5'
		].join('\n');

		expect(parseWfdbHeader(text)).toEqual({ fs: 360, leads: null });
	});
});

describe('statedSignalCount', () => {
	it.each([
		['00001_hr 12 500 5000\n00001_hr.dat 16 1000/mV 16 0 0 0 0 I', 12],
		['# a comment first\r\n\r\n100 2 360 650000\r\n', 2],
		['rec 3', 3],
		['multi/2 12 500 5000', 12],
		['rec twelve 500', null],
		['rec', null],
		['# only a comment', null],
		['', null]
	])('reads %j as %j signals', (text, expected) => {
		expect(statedSignalCount(text)).toBe(expected);
	});
});

describe('isUsableRecordName', () => {
	it.each([
		['00141_hr', true],
		['41084804', true],
		['rec-1', true],
		['심전도', true],
		['rec.v2', false],
		['my rec', false],
		['rec/1', false],
		['e\u0301', false],
		['', false]
	])('takes %j as usable: %j', (name, expected) => {
		expect(isUsableRecordName(name)).toBe(expected);
	});
});

describe('parseWfdbRecordHeader', () => {
	it('reads a PTB-XL style header in full', () => {
		const names = ['I', 'II', 'III', 'AVR', 'AVL', 'AVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
		const text = [
			'00001_hr 12 500 5000',
			...names.map((lead) => signalLine('00001_hr.dat', '1000.0', lead))
		].join('\n');

		const header = parseWfdbRecordHeader(text);

		expect(header.recordName).toBe('00001_hr');
		expect(header.nSig).toBe(12);
		expect(header.fs).toBe(500);
		expect(header.nSamples).toBe(5000);
		expect(header.signals).toHaveLength(12);
		expect(header.signals[3]).toEqual({
			fileName: '00001_hr.dat',
			format: 16,
			samplesPerFrame: 1,
			byteOffset: 0,
			skew: 0,
			gain: 1000,
			baseline: 0,
			units: 'mV',
			description: 'AVR'
		});
		expect(header.signals.map((signal) => signal.description)).toEqual(names);
	});

	it('reads the samples per frame, skew and byte offset suffixes of the format', () => {
		const text = [
			'rec 2 250/1000(0) 0 12:00:00 01/01/2000',
			'rec.dat 16x2:10+0 200 12 0 0 0 0 Lead A',
			'rec.dat 212+512 100(-5)/uV 12 0 0 0 0 Lead B C'
		].join('\r\n');

		const header = parseWfdbRecordHeader(text);

		expect(header.recordName).toBe('rec');
		expect(header.fs).toBe(250);
		expect(header.nSamples).toBeNull();
		expect(header.signals[0]).toMatchObject({
			format: 16,
			samplesPerFrame: 2,
			skew: 10,
			byteOffset: 0,
			gain: 200,
			baseline: 0,
			units: 'mV',
			description: 'Lead A'
		});
		expect(header.signals[1]).toMatchObject({
			format: 212,
			samplesPerFrame: 1,
			skew: 0,
			byteOffset: 512,
			gain: 100,
			baseline: -5,
			units: 'uV',
			description: 'Lead B C'
		});
	});

	it('applies the defaults when the gain and the fields after it are absent', () => {
		const text = ['rec 3 500', 'rec.dat 16', 'rec.dat 16 0 12 1024', 'rec.dat 16 500/mV'].join(
			'\n'
		);

		const header = parseWfdbRecordHeader(text);

		expect(header.signals[0]).toMatchObject({
			gain: 200,
			baseline: 0,
			units: 'mV',
			description: ''
		});
		expect(header.signals[1]).toMatchObject({ gain: 200, baseline: 1024, units: 'mV' });
		expect(header.signals[2]).toMatchObject({ gain: 500, baseline: 0, units: 'mV' });
	});

	it('refuses a multi-segment record', () => {
		expect(() => parseWfdbRecordHeader('rec/2 2 250\nseg1 1000\nseg2 1000')).toThrow(
			'Multi-segment records are not supported.'
		);
	});

	it('takes a header without a rate at 250 Hz', () => {
		expect(parseWfdbRecordHeader('rec 1\nrec.dat 16').fs).toBe(250);
	});

	it('refuses a malformed record line, a missing signal line and a non-positive rate', () => {
		expect(() => parseWfdbRecordHeader('')).toThrow('no record line');
		expect(() => parseWfdbRecordHeader('rec twelve 500')).toThrow('malformed');
		expect(() => parseWfdbRecordHeader('rec 2 500\nrec.dat 16')).toThrow('only 1 signal line');
		expect(() => parseWfdbRecordHeader('rec 1 0\nrec.dat 16')).toThrow('sampling rate');
		expect(() => parseWfdbRecordHeader('rec 1 -500\nrec.dat 16')).toThrow('sampling rate');
	});
});

const spec = (overrides: Partial<WfdbSignalSpec> = {}): WfdbSignalSpec => ({
	fileName: 'rec.dat',
	format: 16,
	samplesPerFrame: 1,
	byteOffset: 0,
	skew: 0,
	gain: 1,
	baseline: 0,
	units: 'mV',
	description: '',
	...overrides
});

const record = (signals: WfdbSignalSpec[], nSamples: number | null = null): WfdbRecordHeader => ({
	recordName: 'rec',
	nSig: signals.length,
	fs: 500,
	nSamples,
	signals
});

const int16 = (values: number[]) => new Int16Array(values).buffer;

const rows = (signals: Float32Array[]) => signals.map((signal) => Array.from(signal));

describe('readWfdbSignals', () => {
	it('reads format 16 with a baseline and a gain', () => {
		const header = record(
			[spec({ gain: 100, baseline: 50 }), spec({ gain: 100, baseline: 50 })],
			2
		);

		const signals = readWfdbSignals(header, int16([150, -50, 50, 250]));

		expect(rows(signals)).toEqual([
			[1, 0],
			[-1, 2]
		]);
	});

	it('unpacks the 12-bit sample pairs of format 212', () => {
		const header = record([spec({ format: 212 }), spec({ format: 212 })], 2);
		// (1000, -5): 1000 = 0x3e8, -5 = 0xffb in 12 bits; (2047, -2047): 0x7ff and 0x801.
		const data = new Uint8Array([0xe8, 0xf3, 0xfb, 0xff, 0x87, 0x01]).buffer;

		const signals = readWfdbSignals(header, data);

		expect(rows(signals)).toEqual([
			[1000, 2047],
			[-5, -2047]
		]);
	});

	it('reads format 80 as unsigned bytes minus 128', () => {
		const header = record([spec({ format: 80 })]);

		const signals = readWfdbSignals(header, new Uint8Array([128, 129, 127, 228]).buffer);

		expect(rows(signals)).toEqual([[0, 1, -1, 100]]);
	});

	it('reads format 61, 24 and 32', () => {
		const bigEndian = new Uint8Array([0x01, 0x00, 0xff, 0xff]).buffer;
		expect(rows(readWfdbSignals(record([spec({ format: 61 })]), bigEndian))).toEqual([[256, -1]]);

		const int24 = new Uint8Array([0x00, 0x00, 0x01, 0xff, 0xff, 0xff]).buffer;
		expect(rows(readWfdbSignals(record([spec({ format: 24 })]), int24))).toEqual([[65536, -1]]);

		const int32 = new Int32Array([100000, -100000]).buffer;
		expect(rows(readWfdbSignals(record([spec({ format: 32 })]), int32))).toEqual([
			[100000, -100000]
		]);
	});

	it('scales microvolt signals to millivolts', () => {
		const header = record([spec({ gain: 1000, units: 'uV' }), spec({ gain: 1000, units: 'UV' })]);

		const signals = readWfdbSignals(header, int16([5000, 2000]));

		expect(signals[0][0]).toBeCloseTo(0.005, 9);
		expect(signals[1][0]).toBeCloseTo(0.002, 9);
	});

	it('reads a missing sample as NaN', () => {
		const signals = readWfdbSignals(record([spec()]), int16([1, -32768, 2]));

		expect(rows(signals)).toEqual([[1, NaN, 2]]);
	});

	it('takes the length from the data when the header states none, never beyond it', () => {
		const data = int16([1, 2, 3, 4, 5]);

		expect(rows(readWfdbSignals(record([spec(), spec()]), data))).toEqual([
			[1, 3],
			[2, 4]
		]);
		expect(rows(readWfdbSignals(record([spec(), spec()], 10), data))).toEqual([
			[1, 3],
			[2, 4]
		]);
		expect(rows(readWfdbSignals(record([spec(), spec()], 1), data))).toEqual([[1], [2]]);
	});

	it('starts reading at the byte offset', () => {
		const header = record([spec({ byteOffset: 4 })]);

		expect(rows(readWfdbSignals(header, int16([9, 9, 1, 2])))).toEqual([[1, 2]]);
	});

	it('refuses format 8 and the layouts it cannot read', () => {
		const data = int16([1, 2]);

		expect(() => readWfdbSignals(record([spec({ format: 8 })]), data)).toThrow('format 8');
		expect(() => readWfdbSignals(record([spec(), spec({ fileName: 'other.dat' })]), data)).toThrow(
			'more than one file'
		);
		expect(() => readWfdbSignals(record([spec({ samplesPerFrame: 2 })]), data)).toThrow(
			'sample per frame'
		);
		expect(() => readWfdbSignals(record([spec({ skew: 1 })]), data)).toThrow('skew');
	});
});
