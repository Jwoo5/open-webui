<script lang="ts">
	import { getContext, tick } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { WEBUI_BASE_URL } from '$lib/constants';
	import { safeImageUrl } from '$lib/utils/safeImageUrl';
	import {
		MAX_ZOOM,
		clampZoom,
		fitWholeZoom,
		wheelZoomFactor,
		zoomAround
	} from '$lib/utils/ecgViewer';

	import ImagePreview from '$lib/components/common/ImagePreview.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import Photo from '$lib/components/icons/Photo.svelte';
	import Minus from '$lib/components/icons/Minus.svelte';
	import Plus from '$lib/components/icons/Plus.svelte';
	import Collapse from '$lib/components/icons/Collapse.svelte';
	import ArrowsPointingOut from '$lib/components/icons/ArrowsPointingOut.svelte';

	const i18n = getContext<Writable<i18nType>>('i18n');

	export let src = '';
	export let alt = '';

	/** The factor a zoom button or key zooms by. */
	const ZOOM_STEP = 1.25;
	/** The pixels one line of a wheel that scrolls by lines stands for. */
	const WHEEL_LINE_PX = 16;

	const toolbarButtonClass =
		'inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md p-1.5 text-gray-500 transition hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent dark:text-gray-400 dark:hover:bg-gray-800';

	let box: HTMLDivElement;

	// Zoom 1 shows the image at the width of the box.
	let zoom = 1;
	let naturalWidth = 0;
	let naturalHeight = 0;
	let boxWidth = 0;
	let boxHeight = 0;

	let showPreview = false;
	let failed = false;
	let shownSrc = '';
	// A mouse drag: the pointer position it scrolls from and the scroll
	// position there, and the pointer position it last moved to.
	let drag: {
		pointerId: number;
		x: number;
		y: number;
		left: number;
		top: number;
		lastX: number;
		lastY: number;
	} | null = null;
	let gestureStartZoom = 1;

	$: _src = safeImageUrl(src.startsWith('/') ? `${WEBUI_BASE_URL}${src}` : src);
	$: minZoom = fitWholeZoom(naturalWidth, naturalHeight, boxWidth, boxHeight);
	$: zoomPercent = Math.round(zoom * 100);

	const resetView = async () => {
		zoom = 1;
		naturalWidth = 0;
		naturalHeight = 0;
		drag = null;
		await tick();
		box?.scrollTo({ left: 0, top: 0 });
	};

	$: if (_src !== shownSrc) {
		shownSrc = _src;
		failed = false;
		resetView();
	}

	// The position of a point of the page inside the visible part of the box.
	const boxPoint = (clientX: number, clientY: number) => {
		const rect = box.getBoundingClientRect();
		return { x: clientX - rect.left - box.clientLeft, y: clientY - rect.top - box.clientTop };
	};

	// Zooms to `next`, within the range, keeping the image point under the
	// box point (x, y) in place; the center of the box by default.
	const setZoom = async (next: number, x?: number, y?: number) => {
		const target = clampZoom(next, minZoom);
		if (!box || target === zoom) {
			return;
		}
		const position = zoomAround(
			{
				zoom,
				scrollX: box.scrollLeft,
				scrollY: box.scrollTop,
				boxW: box.clientWidth,
				boxH: box.clientHeight,
				aspect: naturalWidth > 0 ? naturalHeight / naturalWidth : 0
			},
			target,
			x ?? box.clientWidth / 2,
			y ?? box.clientHeight / 2
		);
		zoom = target;
		await tick();
		box?.scrollTo(position);
		// A drag under way goes on from where the zoom left the view.
		if (box && drag !== null) {
			drag = {
				...drag,
				x: drag.lastX,
				y: drag.lastY,
				left: box.scrollLeft,
				top: box.scrollTop
			};
		}
	};

	const zoomIn = () => setZoom(zoom * ZOOM_STEP);
	const zoomOut = () => setZoom(zoom / ZOOM_STEP);
	const fitWidth = () => setZoom(1);
	const fitWhole = () => setZoom(minZoom);

	const onWheel = (event: WheelEvent) => {
		// A plain wheel scrolls the box, and the chat past its ends.
		if (!(event.ctrlKey || event.metaKey)) {
			return;
		}
		event.preventDefault();
		const unit =
			event.deltaMode === WheelEvent.DOM_DELTA_LINE
				? WHEEL_LINE_PX
				: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
					? box.clientHeight
					: 1;
		const { x, y } = boxPoint(event.clientX, event.clientY);
		setZoom(zoom * wheelZoomFactor(event.deltaY * unit), x, y);
	};

	// Safari reports a trackpad pinch as gesture events, with the scale since
	// the gesture started, instead of as ctrl + wheel.
	type GestureEvent = Event & { scale: number; clientX: number; clientY: number };

	const onGestureStart = (event: Event) => {
		event.preventDefault();
		gestureStartZoom = zoom;
	};

	const onGestureChange = (event: Event) => {
		event.preventDefault();
		const gesture = event as GestureEvent;
		const { x, y } = boxPoint(gesture.clientX, gesture.clientY);
		setZoom(gestureStartZoom * gesture.scale, x, y);
	};

	const onGestureEnd = (event: Event) => {
		event.preventDefault();
	};

	// The wheel listener has to be able to cancel the page zoom, so it is
	// added as not passive; Svelte has no handler syntax for gesture events.
	// They are added to the frame, toolbar included, so a pinch anywhere on
	// the viewer zooms the image rather than the page; a plain wheel over the
	// toolbar scrolls the chat as it does over any other control.
	const zoomGestures = (node: HTMLElement) => {
		node.addEventListener('wheel', onWheel, { passive: false });
		node.addEventListener('gesturestart', onGestureStart);
		node.addEventListener('gesturechange', onGestureChange);
		node.addEventListener('gestureend', onGestureEnd);
		return {
			destroy() {
				node.removeEventListener('wheel', onWheel);
				node.removeEventListener('gesturestart', onGestureStart);
				node.removeEventListener('gesturechange', onGestureChange);
				node.removeEventListener('gestureend', onGestureEnd);
			}
		};
	};

	// A mouse drags the image; touch scrolls the box natively.
	const onPointerDown = (event: PointerEvent) => {
		if (event.pointerType !== 'mouse' || event.button !== 0) {
			return;
		}
		// A press on a scrollbar is left to the scrollbar.
		const { x, y } = boxPoint(event.clientX, event.clientY);
		if (x > box.clientWidth || y > box.clientHeight) {
			return;
		}
		box.setPointerCapture(event.pointerId);
		drag = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			left: box.scrollLeft,
			top: box.scrollTop,
			lastX: event.clientX,
			lastY: event.clientY
		};
	};

	const onPointerMove = (event: PointerEvent) => {
		if (drag === null || event.pointerId !== drag.pointerId) {
			return;
		}
		drag.lastX = event.clientX;
		drag.lastY = event.clientY;
		box.scrollLeft = drag.left - (event.clientX - drag.x);
		box.scrollTop = drag.top - (event.clientY - drag.y);
	};

	const endDrag = (event: PointerEvent) => {
		if (drag === null || event.pointerId !== drag.pointerId) {
			return;
		}
		if (box.hasPointerCapture(event.pointerId)) {
			box.releasePointerCapture(event.pointerId);
		}
		drag = null;
	};

	const onKeydown = (event: KeyboardEvent) => {
		// The browser keeps ctrl/meta + plus and minus for zooming the page.
		if (event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}
		if (event.key === '+' || event.key === '=') {
			zoomIn();
		} else if (event.key === '-') {
			zoomOut();
		} else if (event.key === '0') {
			fitWidth();
		} else {
			return;
		}
		event.preventDefault();
	};

	const onLoad = (event: Event) => {
		const image = event.currentTarget as HTMLImageElement;
		naturalWidth = image.naturalWidth;
		naturalHeight = image.naturalHeight;
	};
</script>

{#if failed}
	<div
		class="rounded-lg inline-flex h-[1.6875rem] min-w-8 gap-1.5 px-2 items-center justify-center overflow-hidden border border-gray-100/50 bg-gray-50/40 text-gray-500 dark:border-white/[0.04] dark:bg-white/[0.03] dark:text-gray-400"
		data-cy="image-unavailable"
	>
		<Photo className="size-3.5 shrink-0" strokeWidth="1.5" />
		<span class="truncate text-xs">
			{$i18n.t('Image unavailable')}
		</span>
	</div>
{:else}
	<ImagePreview bind:show={showPreview} src={_src} {alt} />

	<div
		class="relative w-full h-96 overflow-hidden rounded-lg border border-gray-100 bg-white dark:border-gray-800"
		dir="ltr"
		use:zoomGestures
	>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex -->
		<div
			bind:this={box}
			bind:clientWidth={boxWidth}
			bind:offsetHeight={boxHeight}
			class="grid grid-cols-1 grid-rows-1 h-full w-full overflow-auto select-none outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 {drag ===
			null
				? 'cursor-grab'
				: 'cursor-grabbing'}"
			style="scrollbar-gutter: stable; touch-action: pan-x pan-y;"
			tabindex="0"
			role="region"
			aria-label={$i18n.t('ECG image viewer. Press + or - to zoom and 0 to fit the width.')}
			on:pointerdown={onPointerDown}
			on:pointermove={onPointerMove}
			on:pointerup={endDrag}
			on:pointercancel={endDrag}
			on:lostpointercapture={endDrag}
			on:keydown={onKeydown}
		>
			<img
				src={_src}
				{alt}
				class="m-auto max-w-none select-none"
				style="width: {zoom * 100}%;"
				draggable="false"
				loading="lazy"
				data-cy="ecg-image"
				on:load={onLoad}
				on:error={() => {
					failed = true;
					showPreview = false;
				}}
			/>
		</div>

		<div
			class="absolute top-2 right-5 z-10 flex items-center gap-0.5 rounded-lg border border-gray-200/60 bg-white/90 px-1 py-0.5 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-850/90"
		>
			<Tooltip content={$i18n.t('Zoom out')} placement="top">
				<button
					type="button"
					class={toolbarButtonClass}
					aria-label={$i18n.t('Zoom out')}
					disabled={zoom <= minZoom}
					on:click={zoomOut}
				>
					<Minus className="size-3.5" strokeWidth="2" />
				</button>
			</Tooltip>
			<Tooltip content={$i18n.t('Fit width')} placement="top">
				<button
					type="button"
					class="h-7 min-w-12 shrink-0 rounded-md px-1.5 py-1 text-center text-[0.6875rem] font-normal tabular-nums text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
					aria-label="{zoomPercent}%, {$i18n.t('Fit width')}"
					on:click={fitWidth}
				>
					{zoomPercent}%
				</button>
			</Tooltip>
			<Tooltip content={$i18n.t('Zoom in')} placement="top">
				<button
					type="button"
					class={toolbarButtonClass}
					aria-label={$i18n.t('Zoom in')}
					disabled={zoom >= MAX_ZOOM}
					on:click={zoomIn}
				>
					<Plus className="size-3.5" strokeWidth="2" />
				</button>
			</Tooltip>
			<Tooltip content={$i18n.t('Fit the whole ECG')} placement="top">
				<button
					type="button"
					class={toolbarButtonClass}
					aria-label={$i18n.t('Fit the whole ECG')}
					on:click={fitWhole}
				>
					<Collapse className="size-3.5" />
				</button>
			</Tooltip>
			<Tooltip content={$i18n.t('Expand')} placement="top">
				<button
					type="button"
					class={toolbarButtonClass}
					aria-label={$i18n.t('Expand')}
					on:click={() => {
						showPreview = true;
					}}
				>
					<ArrowsPointingOut className="size-3.5" strokeWidth="2" />
				</button>
			</Tooltip>
		</div>
	</div>
{/if}
