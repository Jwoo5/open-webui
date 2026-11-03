import { describe, expect, it } from 'vitest';
import { ecgImageLayout, fittingPxPerMm, renderEcgImage } from './ecgImage';
import { CANONICAL_LEADS } from './wfdb';

describe('ecgImageLayout', () => {
	it('lays out twelve rows over ten seconds at the default scales', () => {
		expect(ecgImageLayout(12, 10)).toEqual({
			width: 1048,
			height: 1488,
			marginPx: 24,
			rowSpacingPx: 120,
			pxPerSecond: 100,
			pxPerMillivolt: 40
		});
	});

	it('applies the given scales and rounds the size up', () => {
		expect(ecgImageLayout(2, 1.5, { pxPerMm: 3, marginMm: 2 })).toEqual({
			width: 125,
			height: 192,
			marginPx: 6,
			rowSpacingPx: 90,
			pxPerSecond: 75,
			pxPerMillivolt: 30
		});
	});

	it('leaves only the margins for an empty record', () => {
		expect(ecgImageLayout(0, 0)).toMatchObject({ width: 48, height: 48 });
	});

	it('doubles every size at 8 px/mm', () => {
		expect(ecgImageLayout(12, 10, { pxPerMm: 8 })).toEqual({
			width: 2096,
			height: 2976,
			marginPx: 48,
			rowSpacingPx: 240,
			pxPerSecond: 200,
			pxPerMillivolt: 80
		});
	});
});

describe('fittingPxPerMm', () => {
	const resolutions = [8, 4];

	it('keeps the finer resolution for a ten-second record', () => {
		expect(fittingPxPerMm(12, 10, resolutions)).toBe(8);
	});

	it('falls back once the finer drawing holds more pixels than iOS Safari allows', () => {
		// 27 s at 8 px/mm is 5496 x 2976, about 16.4 MP; 28 s is 5696 x 2976, about 17.0 MP.
		expect(fittingPxPerMm(12, 27, resolutions)).toBe(8);
		expect(fittingPxPerMm(12, 28, resolutions)).toBe(4);
	});

	it('falls back for a record wider than a canvas at the finer resolution', () => {
		// 90 s at 8 px/mm is 18096 px wide; at 4 px/mm it is 9048 px.
		expect(fittingPxPerMm(12, 90, resolutions)).toBe(4);
		expect(ecgImageLayout(12, 90, { pxPerMm: 4 }).width).toBe(9048);
	});

	it('gives the last resolution when none fits', () => {
		expect(fittingPxPerMm(12, 600, resolutions)).toBe(4);
	});
});

type Call = { name: string; args: unknown[] };

// A canvas whose context records the calls made on it, and the line widths
// and fonts set on it as calls named after the property, since the test
// runner has no drawing surface.
const recordingCanvas = () => {
	const calls: Call[] = [];
	const record =
		(name: string) =>
		(...args: unknown[]) =>
			calls.push({ name, args });
	const context = {
		fillRect: record('fillRect'),
		beginPath: record('beginPath'),
		moveTo: record('moveTo'),
		lineTo: record('lineTo'),
		stroke: record('stroke'),
		fillText: record('fillText')
	};
	for (const property of ['lineWidth', 'font']) {
		Object.defineProperty(context, property, { set: record(property) });
	}
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => context,
		toBlob: (callback: (blob: Blob | null) => void, type: string) =>
			callback(new Blob(['png'], { type }))
	};
	(globalThis as { document?: unknown }).document = { createElement: () => canvas };
	return { canvas, calls };
};

describe('renderEcgImage', () => {
	const fs = 100;
	const fileOrder = ['I', 'II', 'III', 'aVR', 'aVF', 'aVL', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
	// Channel c holds the constant value c / 10 mV, so a row's first point tells
	// which channel it was drawn from.
	const signals = fileOrder.map((_, channel) => new Float32Array(2 * fs).fill(channel / 10));

	it('draws one row per canonical lead from the channel named after it', async () => {
		const { canvas, calls } = recordingCanvas();
		const blob = await renderEcgImage(signals, fs, fileOrder);
		const layout = ecgImageLayout(12, 2);

		expect(blob.type).toBe('image/png');
		expect(canvas.width).toBe(layout.width);
		expect(canvas.height).toBe(layout.height);

		const labels = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
		expect(labels.slice(0, 12)).toEqual([...CANONICAL_LEADS]);
		expect(labels[12]).toBe('25 mm/s  10 mm/mV');

		// Two grid strokes, then one per lead, each starting at the left edge
		// of the plot on its row's baseline shifted by the channel's value.
		expect(calls.filter((c) => c.name === 'stroke').length).toBe(14);
		const starts = calls.filter((c) => c.name === 'moveTo').slice(-12);
		CANONICAL_LEADS.forEach((lead, row) => {
			const channel = fileOrder.indexOf(lead);
			const [x, y] = starts[row].args as number[];
			expect(x).toBe(layout.marginPx);
			expect(y).toBeCloseTo(
				layout.marginPx +
					(row + 0.5) * layout.rowSpacingPx -
					(channel / 10) * layout.pxPerMillivolt,
				4
			);
		});
	});

	it('leaves a gap where a sample is missing and an empty row for an absent lead', async () => {
		const { calls } = recordingCanvas();
		const withGap = signals.map((signal) => Float32Array.from(signal));
		withGap[0][fs] = NaN;
		await renderEcgImage(withGap, fs, fileOrder.slice(0, 11));

		// After the two grid strokes: lead I starts twice, once after the gap,
		// the other ten drawn leads once; V6 has no channel and only a label.
		const secondGridStroke = calls.findIndex(
			(c, index) => c.name === 'stroke' && calls.slice(0, index).some((d) => d.name === 'stroke')
		);
		const traceStarts = calls.slice(secondGridStroke + 1).filter((c) => c.name === 'moveTo');
		expect(traceStarts.length).toBe(12);
		expect(calls.filter((c) => c.name === 'stroke').length).toBe(2 + 11);
	});

	const drawnAt = async (pxPerMm?: number) => {
		const { calls } = recordingCanvas();
		await renderEcgImage(signals, fs, fileOrder, pxPerMm === undefined ? {} : { pxPerMm });
		const set = (name: string) => calls.filter((c) => c.name === name).map((c) => c.args[0]);
		const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args.slice(1));
		const gridStarts = calls
			.filter((c) => c.name === 'moveTo')
			.slice(0, 2)
			.map((c) => c.args);
		return { lineWidths: set('lineWidth'), fonts: set('font'), texts, gridStarts };
	};

	it('draws at the reference line widths and fonts by default', async () => {
		const drawn = await drawnAt();

		expect(drawn.lineWidths).toEqual([1, 1, 1.25]);
		expect(drawn.fonts).toEqual(['11px sans-serif', '10px sans-serif']);
		// The first minor grid line sits on a pixel center.
		expect(drawn.gridStarts[0]).toEqual([24.5, 24]);
		expect(drawn.texts[0]).toEqual([26, 26]);
	});

	it('scales the line widths, fonts and text offsets at 8 px/mm', async () => {
		const drawn = await drawnAt(8);
		const layout = ecgImageLayout(12, 2, { pxPerMm: 8 });

		expect(drawn.lineWidths).toEqual([2, 2, 2.5]);
		expect(drawn.fonts).toEqual(['22px sans-serif', '20px sans-serif']);
		// A 2 px grid line covers two whole pixels, so it sits on a pixel edge.
		expect(drawn.gridStarts[0]).toEqual([48, 48]);
		expect(drawn.texts[0]).toEqual([52, 52]);
		expect(drawn.texts[12]).toEqual([layout.width - 8, layout.height - 6]);
	});
});
