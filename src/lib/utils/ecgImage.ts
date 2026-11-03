/**
 * Drawing of a 12-lead ECG on a canvas the way ECG paper shows it: the
 * leads stacked in one column over the whole record, on a millimeter grid.
 */

import { CANONICAL_LEADS, canonicalLeadName } from './wfdb';

/** The scales of the drawing: millimeters of ECG paper per unit, and pixels per millimeter. */
export type EcgImageOptions = {
	pxPerMm?: number;
	mmPerSecond?: number;
	mmPerMillivolt?: number;
	rowSpacingMm?: number;
	marginMm?: number;
};

/** The pixel size of the picture and the scales it is drawn at. */
export type EcgImageLayout = {
	width: number;
	height: number;
	marginPx: number;
	rowSpacingPx: number;
	pxPerSecond: number;
	pxPerMillivolt: number;
};

const DEFAULT_OPTIONS: Required<EcgImageOptions> = {
	pxPerMm: 4,
	mmPerSecond: 25,
	mmPerMillivolt: 10,
	// 3 mV between rows, so a tall complex stays clear of its neighbors.
	rowSpacingMm: 30,
	marginMm: 6
};

const BACKGROUND_COLOR = '#ffffff';
const MINOR_GRID_COLOR = '#f6c9c9';
const MAJOR_GRID_COLOR = '#e8a0a0';
const TRACE_COLOR = '#000000';
const NOTE_COLOR = '#555555';

/**
 * The pixels per millimeter the line widths, font sizes and text offsets
 * below are given at; a drawing at another resolution scales them, so it
 * looks the same at a different size.
 */
const REFERENCE_PX_PER_MM = 4;
const GRID_LINE_WIDTH = 1;
const TRACE_LINE_WIDTH = 1.25;
const LABEL_FONT_PX = 11;
const NOTE_FONT_PX = 10;

/** The longest side a canvas can have in the browsers the chat runs in. */
const MAX_CANVAS_SIDE = 16384;

/**
 * The most pixels a canvas can hold in iOS Safari, the lowest limit among
 * the browsers the chat runs in; a larger canvas there gives no context.
 */
const MAX_CANVAS_AREA = 4096 * 4096;

const resolveOptions = (options: EcgImageOptions): Required<EcgImageOptions> => ({
	pxPerMm: options.pxPerMm ?? DEFAULT_OPTIONS.pxPerMm,
	mmPerSecond: options.mmPerSecond ?? DEFAULT_OPTIONS.mmPerSecond,
	mmPerMillivolt: options.mmPerMillivolt ?? DEFAULT_OPTIONS.mmPerMillivolt,
	rowSpacingMm: options.rowSpacingMm ?? DEFAULT_OPTIONS.rowSpacingMm,
	marginMm: options.marginMm ?? DEFAULT_OPTIONS.marginMm
});

/**
 * The size of the picture and the scales it is drawn at: a margin, then one
 * row per lead, then a margin, with the width covering the whole duration.
 */
export const ecgImageLayout = (
	nRows: number,
	durationSeconds: number,
	options: EcgImageOptions = {}
): EcgImageLayout => {
	const { pxPerMm, mmPerSecond, mmPerMillivolt, rowSpacingMm, marginMm } = resolveOptions(options);
	const marginPx = marginMm * pxPerMm;
	const rowSpacingPx = rowSpacingMm * pxPerMm;
	const pxPerSecond = mmPerSecond * pxPerMm;
	const pxPerMillivolt = mmPerMillivolt * pxPerMm;

	return {
		width: Math.ceil(marginPx + durationSeconds * pxPerSecond + marginPx),
		height: Math.ceil(marginPx + nRows * rowSpacingPx + marginPx),
		marginPx,
		rowSpacingPx,
		pxPerSecond,
		pxPerMillivolt
	};
};

/**
 * The first of `resolutions`, in pixels per millimeter and best first, at
 * which a drawing of `nRows` rows over `durationSeconds` fits a canvas in
 * every browser the chat runs in, or the last of them when none does; the
 * renderer refuses a drawing at that one only if it is longer than any
 * canvas can show.
 */
export const fittingPxPerMm = (
	nRows: number,
	durationSeconds: number,
	resolutions: readonly number[],
	options: EcgImageOptions = {}
): number => {
	const fitting = resolutions.find((pxPerMm) => {
		const { width, height } = ecgImageLayout(nRows, durationSeconds, { ...options, pxPerMm });
		return (
			width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE && width * height <= MAX_CANVAS_AREA
		);
	});
	return fitting ?? resolutions[resolutions.length - 1];
};

/**
 * Lines `lineWidth` pixels wide every `stepPx` across the plot area, placed
 * so that they cover whole pixels: on pixel centers for an odd width, on
 * pixel edges for an even one.
 */
const drawGrid = (
	ctx: CanvasRenderingContext2D,
	left: number,
	top: number,
	width: number,
	height: number,
	stepPx: number,
	lineWidth: number,
	color: string
) => {
	const offset = (lineWidth % 2) / 2;
	ctx.strokeStyle = color;
	ctx.lineWidth = lineWidth;
	ctx.beginPath();
	for (let x = left; x <= left + width; x += stepPx) {
		const crisp = Math.round(x) + offset;
		ctx.moveTo(crisp, top);
		ctx.lineTo(crisp, top + height);
	}
	for (let y = top; y <= top + height; y += stepPx) {
		const crisp = Math.round(y) + offset;
		ctx.moveTo(left, crisp);
		ctx.lineTo(left + width, crisp);
	}
	ctx.stroke();
};

/**
 * Draws the signals as a PNG: the twelve canonical leads in one column, one
 * row each, over a grid of 1 mm minor and 5 mm major lines. `leadNames[i]`
 * names channel `i`; a channel named outside the twelve is not drawn, and a
 * lead no channel is named after leaves its row empty but for the label.
 * A sample that is not finite leaves a gap in the trace. Lines, labels and
 * their offsets grow with `pxPerMm`, so a drawing at 8 px/mm is the one at
 * 4 px/mm at twice the resolution.
 */
export const renderEcgImage = async (
	signals: Float32Array[],
	fs: number,
	leadNames: string[],
	options: EcgImageOptions = {}
): Promise<Blob> => {
	if (!Number.isFinite(fs) || fs <= 0) {
		throw new Error('The sampling rate must be above 0 Hz.');
	}

	const { pxPerMm, mmPerSecond, mmPerMillivolt } = resolveOptions(options);
	const rows = CANONICAL_LEADS.map((lead) => {
		const channel = leadNames.findIndex((name) => canonicalLeadName(name) === lead);
		return { lead, signal: channel === -1 ? null : (signals[channel] ?? null) };
	});
	const durationSeconds = Math.max(0, ...rows.map(({ signal }) => signal?.length ?? 0)) / fs;
	const layout = ecgImageLayout(rows.length, durationSeconds, options);
	const { width, height, marginPx, rowSpacingPx, pxPerSecond, pxPerMillivolt } = layout;

	if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
		throw new Error(
			`A record of ${durationSeconds.toFixed(1)} seconds is longer than a preview can show.`
		);
	}

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (ctx === null) {
		throw new Error('The browser did not provide a drawing context.');
	}

	ctx.fillStyle = BACKGROUND_COLOR;
	ctx.fillRect(0, 0, width, height);

	const scale = pxPerMm / REFERENCE_PX_PER_MM;
	const gridLineWidth = Math.max(1, Math.round(GRID_LINE_WIDTH * scale));

	const plotWidth = durationSeconds * pxPerSecond;
	const plotHeight = rows.length * rowSpacingPx;
	drawGrid(
		ctx,
		marginPx,
		marginPx,
		plotWidth,
		plotHeight,
		pxPerMm,
		gridLineWidth,
		MINOR_GRID_COLOR
	);
	drawGrid(
		ctx,
		marginPx,
		marginPx,
		plotWidth,
		plotHeight,
		5 * pxPerMm,
		gridLineWidth,
		MAJOR_GRID_COLOR
	);

	ctx.fillStyle = TRACE_COLOR;
	ctx.strokeStyle = TRACE_COLOR;
	ctx.lineWidth = TRACE_LINE_WIDTH * scale;
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	ctx.font = `${LABEL_FONT_PX * scale}px sans-serif`;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'top';

	rows.forEach(({ lead, signal }, rowIndex) => {
		const rowTop = marginPx + rowIndex * rowSpacingPx;
		const baseline = rowTop + 0.5 * rowSpacingPx;
		ctx.fillText(lead, marginPx + 2 * scale, rowTop + 2 * scale);

		if (signal === null) {
			return;
		}

		ctx.beginPath();
		let open = false;
		for (let index = 0; index < signal.length; index += 1) {
			const value = signal[index];
			if (!Number.isFinite(value)) {
				open = false;
				continue;
			}
			const x = marginPx + (index / fs) * pxPerSecond;
			const y = baseline - value * pxPerMillivolt;
			if (open) {
				ctx.lineTo(x, y);
			} else {
				ctx.moveTo(x, y);
				open = true;
			}
		}
		ctx.stroke();
	});

	ctx.fillStyle = NOTE_COLOR;
	ctx.font = `${NOTE_FONT_PX * scale}px sans-serif`;
	ctx.textAlign = 'right';
	ctx.textBaseline = 'bottom';
	ctx.fillText(
		`${mmPerSecond} mm/s  ${mmPerMillivolt} mm/mV`,
		width - 4 * scale,
		height - 3 * scale
	);

	return new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob === null) {
				reject(new Error('The browser could not encode the picture as PNG.'));
			} else {
				resolve(blob);
			}
		}, 'image/png');
	});
};
