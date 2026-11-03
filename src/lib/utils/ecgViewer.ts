/**
 * The geometry of the inline ECG image viewer, and the check for the model
 * whose answers it shows the pictures of.
 *
 * The viewer shows the image inside a scroll box at `zoom` times the width
 * of the box, so zoom 1 fits the width; an image smaller than the box sits
 * in its center.
 */

export const ECG_AGENT_MODEL_ID = 'ecg-reasoning-agent';

/** The largest zoom the viewer allows, in multiples of the box width. */
export const MAX_ZOOM = 8;

/**
 * How far ctrl/meta + wheel zooms per pixel of scroll. Chromium sends a
 * trackpad pinch to the scale `s` as a wheel of `deltaY = -100 ln(s)`, so
 * at this rate the pinch zooms as far as the fingers move.
 */
const WHEEL_ZOOM_RATE = 0.01;

/**
 * The most pixels of scroll one wheel event zooms by, so that a mouse notch,
 * 100 pixels in Chromium, zooms by about as much as a zoom button rather
 * than e times; a pinch moves by far less per event.
 */
const MAX_WHEEL_ZOOM_DELTA = 25;

/**
 * Whether the model id names the ECG agent: the id itself, or the id behind
 * the prefix an Open WebUI connection puts in front of its models.
 */
export const isEcgAgentModel = (id: unknown): boolean =>
	typeof id === 'string' && (id === ECG_AGENT_MODEL_ID || id.endsWith(`.${ECG_AGENT_MODEL_ID}`));

/**
 * The zoom at which the whole image fits in the box: its height then equals
 * the box height, unless the image is wide enough for the width to fit it
 * whole already. 1 when a size is not known yet.
 */
export const fitWholeZoom = (natW: number, natH: number, boxW: number, boxH: number): number => {
	if (!(natW > 0 && natH > 0 && boxW > 0 && boxH > 0)) {
		return 1;
	}
	return Math.min(1, (boxH * natW) / (boxW * natH));
};

/**
 * The factor a ctrl/meta + wheel event zooms by, given its vertical scroll
 * in pixels: up zooms in, down zooms out.
 */
export const wheelZoomFactor = (deltaYPx: number): number =>
	Math.exp(
		-Math.min(MAX_WHEEL_ZOOM_DELTA, Math.max(-MAX_WHEEL_ZOOM_DELTA, deltaYPx)) * WHEEL_ZOOM_RATE
	);

/** The zoom limited to `[min, max]`; a zoom that is not a number gives `min`. */
export const clampZoom = (zoom: number, min: number, max = MAX_ZOOM): number =>
	Number.isFinite(zoom) ? Math.min(max, Math.max(min, zoom)) : min;

export type ViewerView = {
	zoom: number;
	scrollX: number;
	scrollY: number;
	boxW: number;
	boxH: number;
	/** The image height over its width. */
	aspect: number;
};

/** Where the image starts inside the scroll content along one side of the box. */
const centeringOffset = (box: number, image: number): number => Math.max(0, (box - image) / 2);

/**
 * The scroll position that keeps the point of the image under `(px, py)`,
 * measured from the top left of the box, where it is when the zoom changes
 * from `view.zoom` to `next`, limited to the positions the box can scroll to.
 */
export const zoomAround = (
	view: ViewerView,
	next: number,
	px: number,
	py: number
): { left: number; top: number } => {
	const { zoom, scrollX, scrollY, boxW, boxH, aspect } = view;

	const width = zoom * boxW;
	const height = width * aspect;
	const nextWidth = next * boxW;
	const nextHeight = nextWidth * aspect;

	// The point as a fraction of the image, which the zoom does not move.
	const u = width > 0 ? (scrollX + px - centeringOffset(boxW, width)) / width : 0;
	const v = height > 0 ? (scrollY + py - centeringOffset(boxH, height)) / height : 0;

	const left = u * nextWidth + centeringOffset(boxW, nextWidth) - px;
	const top = v * nextHeight + centeringOffset(boxH, nextHeight) - py;

	return {
		left: Math.min(Math.max(0, nextWidth - boxW), Math.max(0, left)),
		top: Math.min(Math.max(0, nextHeight - boxH), Math.max(0, top))
	};
};
