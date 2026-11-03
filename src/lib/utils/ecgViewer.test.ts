import { describe, expect, it } from 'vitest';
import {
	ECG_AGENT_MODEL_ID,
	MAX_ZOOM,
	clampZoom,
	fitWholeZoom,
	isEcgAgentModel,
	wheelZoomFactor,
	zoomAround
} from './ecgViewer';

describe('isEcgAgentModel', () => {
	it.each([
		[ECG_AGENT_MODEL_ID, true],
		['ecg.ecg-reasoning-agent', true],
		['demo.ecg-reasoning-agent', true],
		['ecg-reasoning-agent-v2', false],
		['my-ecg-reasoning-agent', false],
		['case:ptbxl-00003', false],
		['', false],
		[undefined, false],
		[null, false]
	])('takes %j for the agent: %j', (id, expected) => {
		expect(isEcgAgentModel(id)).toBe(expected);
	});
});

describe('fitWholeZoom', () => {
	it('shrinks a tall image until its height fits the box', () => {
		// A 10 s preview at 8 px/mm in a 768 x 384 box.
		const zoom = fitWholeZoom(2096, 2976, 768, 384);
		expect(zoom).toBeCloseTo((384 * 2096) / (768 * 2976), 10);
		expect(zoom * 768 * (2976 / 2096)).toBeCloseTo(384, 6);
	});

	it('keeps the width fit for an image that is wide enough already', () => {
		expect(fitWholeZoom(4000, 1000, 800, 400)).toBe(1);
	});

	it('gives 1 while a size is unknown', () => {
		expect(fitWholeZoom(0, 0, 800, 400)).toBe(1);
		expect(fitWholeZoom(2096, 2976, 0, 384)).toBe(1);
	});
});

describe('wheelZoomFactor', () => {
	// The wheel Chromium sends for a trackpad pinch to the scale s.
	const pinch = (scale: number) => -100 * Math.log(scale);

	it('zooms as far as a Chromium trackpad pinch moves the fingers', () => {
		expect(wheelZoomFactor(pinch(1.1))).toBeCloseTo(1.1, 10);
		expect(wheelZoomFactor(pinch(0.9))).toBeCloseTo(0.9, 10);

		// Spreading the fingers to twice their distance over twenty events.
		const steps = Array.from({ length: 20 }, () => wheelZoomFactor(pinch(2 ** (1 / 20))));
		expect(steps.reduce((zoom, factor) => zoom * factor, 1)).toBeCloseTo(2, 10);
	});

	it('zooms in on a scroll up and out on a scroll down', () => {
		expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
		expect(wheelZoomFactor(10)).toBeLessThan(1);
		expect(wheelZoomFactor(0)).toBe(1);
	});

	it('zooms a mouse notch by about one button step', () => {
		expect(wheelZoomFactor(-100)).toBeCloseTo(Math.exp(0.25), 10);
		expect(wheelZoomFactor(100)).toBeCloseTo(Math.exp(-0.25), 10);
		expect(wheelZoomFactor(-1000)).toBe(wheelZoomFactor(-100));
	});
});

describe('clampZoom', () => {
	it('limits the zoom to the range', () => {
		expect(clampZoom(0.1, 0.25)).toBe(0.25);
		expect(clampZoom(20, 0.25)).toBe(MAX_ZOOM);
		expect(clampZoom(2, 0.25)).toBe(2);
		expect(clampZoom(3, 0.25, 2.5)).toBe(2.5);
		expect(clampZoom(Number.NaN, 0.25)).toBe(0.25);
	});
});

describe('zoomAround', () => {
	const boxW = 800;
	const boxH = 400;
	const aspect = 1.5;

	// Where the image point under (px, py) is, as a fraction of the image, for
	// a view at the given zoom and scroll position.
	const pointUnder = (zoom: number, left: number, top: number, px: number, py: number) => {
		const width = zoom * boxW;
		const height = width * aspect;
		const offsetX = Math.max(0, (boxW - width) / 2);
		const offsetY = Math.max(0, (boxH - height) / 2);
		return [(left + px - offsetX) / width, (top + py - offsetY) / height];
	};

	it('keeps the point under the pointer in place when zooming in', () => {
		const view = { zoom: 1, scrollX: 0, scrollY: 300, boxW, boxH, aspect };
		const next = zoomAround(view, 2, 200, 100);

		const before = pointUnder(1, 0, 300, 200, 100);
		const after = pointUnder(2, next.left, next.top, 200, 100);
		expect(after[0]).toBeCloseTo(before[0], 10);
		expect(after[1]).toBeCloseTo(before[1], 10);
		expect(next).toEqual({ left: 200, top: 700 });
	});

	it('keeps the point in place when zooming out to a centered image', () => {
		const view = { zoom: 2, scrollX: 400, scrollY: 900, boxW, boxH, aspect };
		const next = zoomAround(view, 0.25, 400, 200);

		// At 0.25 the image is 200 x 300, centered: nothing to scroll.
		expect(next).toEqual({ left: 0, top: 0 });
	});

	it('accounts for the centering offset of an image narrower than the box', () => {
		// At 0.5 the image is 400 x 600, 200 px in from either side.
		const view = { zoom: 0.5, scrollX: 0, scrollY: 100, boxW, boxH, aspect };
		const next = zoomAround(view, 2, 300, 200);

		const before = pointUnder(0.5, 0, 100, 300, 200);
		const after = pointUnder(2, next.left, next.top, 300, 200);
		expect(after[0]).toBeCloseTo(before[0], 10);
		expect(after[1]).toBeCloseTo(before[1], 10);
		expect(next).toEqual({ left: 100, top: 1000 });
	});

	it('stays within the positions the box can scroll to', () => {
		const view = { zoom: 1, scrollX: 0, scrollY: 0, boxW, boxH, aspect };

		expect(zoomAround(view, 2, 0, 0)).toEqual({ left: 0, top: 0 });

		const end = { zoom: 1, scrollX: 0, scrollY: 1200 - boxH, boxW, boxH, aspect };
		const zoomed = zoomAround(end, 1.25, boxW, boxH);
		expect(zoomed.left).toBe(1000 - boxW);
		expect(zoomed.top).toBe(1500 - boxH);
	});
});
