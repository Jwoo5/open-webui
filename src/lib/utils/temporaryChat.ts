/**
 * Keeps the open temporary chat in the tab's session storage, so a reload
 * brings it back and closing the tab drops it.
 */

export const TEMPORARY_CHAT_STORAGE_KEY = 'temporary-chat';
/** How often a chat that keeps changing, such as one being answered, is written. */
export const TEMPORARY_CHAT_SAVE_DELAY_MS = 500;
/** The error left on an answer that was still being written when the page was reloaded. */
export const INTERRUPTED_ANSWER_ERROR = 'The answer was interrupted when the page was reloaded.';

export type TemporaryChatHistory = {
	messages: Record<string, any>;
	currentId: string | null;
};

export type TemporaryChatState = {
	history: TemporaryChatHistory;
	chatFiles: any[];
	selectedModels: string[];
	params: Record<string, any>;
};

export type TemporaryChatStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const isRecord = (value: unknown): value is Record<string, any> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const hasMessages = (state: TemporaryChatState) =>
	Object.keys(state.history?.messages ?? {}).length > 0;

/**
 * Return a copy of *history* in which every answer that was not finished is
 * closed with an error, so the restored chat shows no answer as still running.
 */
export const settleInterruptedAnswers = (history: TemporaryChatHistory): TemporaryChatHistory => {
	const messages: Record<string, any> = {};
	for (const [id, message] of Object.entries(history.messages)) {
		if (isRecord(message) && message.role === 'assistant' && message.done !== true) {
			messages[id] = {
				...message,
				done: true,
				error: message.error ?? { content: INTERRUPTED_ANSWER_ERROR },
				statusHistory: Array.isArray(message.statusHistory)
					? message.statusHistory.map((status: unknown) =>
							isRecord(status) ? { ...status, done: true } : status
						)
					: message.statusHistory
			};
		} else {
			messages[id] = message;
		}
	}
	return { ...history, messages };
};

/** Read a kept chat, or null when *raw* does not hold one. */
export const parseTemporaryChat = (raw: string | null): TemporaryChatState | null => {
	if (!raw) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(value) || !isRecord(value.history) || !isRecord(value.history.messages)) {
		return null;
	}
	const currentId = value.history.currentId;
	return {
		history: settleInterruptedAnswers({
			messages: value.history.messages,
			currentId: typeof currentId === 'string' ? currentId : null
		}),
		chatFiles: Array.isArray(value.chatFiles) ? value.chatFiles : [],
		selectedModels: Array.isArray(value.selectedModels)
			? value.selectedModels.filter((id: unknown): id is string => typeof id === 'string')
			: [],
		params: isRecord(value.params) ? value.params : {}
	};
};

/**
 * A keeper of one tab's temporary chat.
 *
 * The first new chat of a page load takes what the tab kept before the
 * reload; every later new chat starts empty, and the empty chat replaces
 * what was kept once it is saved. Nothing is written before that first
 * take, so the empty chat shown while the page loads cannot overwrite the
 * one being brought back.
 */
export const createTemporaryChatKeeper = (
	getStorage: () => TemporaryChatStorage | null,
	delayMs: number = TEMPORARY_CHAT_SAVE_DELAY_MS
) => {
	let restorable = true;
	let pending: TemporaryChatState | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const storage = (): TemporaryChatStorage | null => {
		try {
			return getStorage();
		} catch {
			return null;
		}
	};

	const remove = (target: TemporaryChatStorage) => {
		try {
			target.removeItem(TEMPORARY_CHAT_STORAGE_KEY);
		} catch {
			// Storage that refuses a removal has nothing more to give up.
		}
	};

	const write = (state: TemporaryChatState) => {
		const target = storage();
		if (!target) {
			return;
		}
		if (!hasMessages(state)) {
			remove(target);
			return;
		}
		try {
			target.setItem(
				TEMPORARY_CHAT_STORAGE_KEY,
				JSON.stringify({
					history: state.history,
					chatFiles: state.chatFiles,
					selectedModels: state.selectedModels,
					params: state.params
				})
			);
		} catch (error) {
			// A chat too large for the storage is dropped rather than kept out of date.
			console.warn('The temporary chat could not be kept for a reload:', error);
			remove(target);
		}
	};

	const flush = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (pending !== null) {
			const state = pending;
			pending = null;
			write(state);
		}
	};

	return {
		/**
		 * On the first call of a page load, return the chat the tab kept, or
		 * null; later calls return null. When temporary chat is off, the kept
		 * chat is dropped instead.
		 */
		take(temporaryChatEnabled: boolean): TemporaryChatState | null {
			if (!restorable) {
				return null;
			}
			restorable = false;
			const target = storage();
			if (!target) {
				return null;
			}
			if (!temporaryChatEnabled) {
				remove(target);
				return null;
			}
			let raw: string | null = null;
			try {
				raw = target.getItem(TEMPORARY_CHAT_STORAGE_KEY);
			} catch {
				return null;
			}
			const state = parseTemporaryChat(raw);
			if (state === null) {
				remove(target);
			}
			return state;
		},

		/**
		 * Keep *state* within the save delay, the latest state given winning.
		 * The state is read when it is written, so changes made to it in place
		 * meanwhile are kept as well.
		 */
		save(state: TemporaryChatState) {
			if (restorable) {
				return;
			}
			pending = state;
			if (timer === null) {
				timer = setTimeout(flush, delayMs);
			}
		},

		/** Write a pending state now, as the page is left. */
		flush
	};
};

/** The keeper of this tab's temporary chat. */
export const temporaryChatKeeper = createTemporaryChatKeeper(() =>
	typeof sessionStorage === 'undefined' ? null : sessionStorage
);
