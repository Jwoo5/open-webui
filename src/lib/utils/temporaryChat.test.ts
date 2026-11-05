import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	INTERRUPTED_ANSWER_ERROR,
	TEMPORARY_CHAT_SAVE_DELAY_MS,
	TEMPORARY_CHAT_STORAGE_KEY,
	createTemporaryChatKeeper,
	parseTemporaryChat,
	settleInterruptedAnswers,
	type TemporaryChatState,
	type TemporaryChatStorage
} from './temporaryChat';

class MemoryStorage implements TemporaryChatStorage {
	items = new Map<string, string>();
	limit = Infinity;

	getItem(key: string) {
		return this.items.get(key) ?? null;
	}

	setItem(key: string, value: string) {
		if (value.length > this.limit) {
			throw new Error('QuotaExceededError');
		}
		this.items.set(key, value);
	}

	removeItem(key: string) {
		this.items.delete(key);
	}
}

const chatWith = (messages: Record<string, any>, currentId: string | null = null) =>
	({
		history: { messages, currentId },
		chatFiles: [{ id: 'file-1', type: 'file' }],
		selectedModels: ['ecg-reasoning-agent'],
		params: { temperature: 0 }
	}) satisfies TemporaryChatState;

const answeredChat = () =>
	chatWith(
		{
			q: { id: 'q', role: 'user', content: 'Is this AF?', childrenIds: ['a'] },
			a: { id: 'a', role: 'assistant', content: 'No.', done: true, parentId: 'q' }
		},
		'a'
	);

describe('settleInterruptedAnswers', () => {
	it('closes an unfinished answer with an error and its statuses as done', () => {
		const settled = settleInterruptedAnswers({
			messages: {
				q: { id: 'q', role: 'user', content: 'Q' },
				a: {
					id: 'a',
					role: 'assistant',
					content: 'Partly',
					done: false,
					statusHistory: [{ description: 'Analyzing the recording', done: false }]
				}
			},
			currentId: 'a'
		});
		expect(settled.messages.a.done).toBe(true);
		expect(settled.messages.a.error).toEqual({ content: INTERRUPTED_ANSWER_ERROR });
		expect(settled.messages.a.content).toBe('Partly');
		expect(settled.messages.a.statusHistory).toEqual([
			{ description: 'Analyzing the recording', done: true }
		]);
		expect(settled.messages.q).toEqual({ id: 'q', role: 'user', content: 'Q' });
		expect(settled.currentId).toBe('a');
	});

	it('leaves finished answers and an earlier error as they were', () => {
		const failed = { id: 'b', role: 'assistant', done: false, error: { content: 'Earlier' } };
		const settled = settleInterruptedAnswers({
			messages: { a: answeredChat().history.messages.a, b: failed },
			currentId: 'b'
		});
		expect(settled.messages.a).toEqual(answeredChat().history.messages.a);
		expect(settled.messages.b.error).toEqual({ content: 'Earlier' });
	});
});

describe('parseTemporaryChat', () => {
	it.each([null, '', 'not json', '[]', '{}', '{"history": {}}', '{"history": {"messages": []}}'])(
		'reads %j as no chat',
		(raw) => {
			expect(parseTemporaryChat(raw)).toBeNull();
		}
	);

	it('fills what a kept chat lacks with empty values', () => {
		const state = parseTemporaryChat(JSON.stringify({ history: { messages: {}, currentId: 3 } }));
		expect(state).toEqual({
			history: { messages: {}, currentId: null },
			chatFiles: [],
			selectedModels: [],
			params: {}
		});
	});
});

describe('createTemporaryChatKeeper', () => {
	let storage: MemoryStorage;

	beforeEach(() => {
		vi.useFakeTimers();
		storage = new MemoryStorage();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const reloadedKeeper = () => createTemporaryChatKeeper(() => storage);

	it('brings a saved chat back after a reload, once', () => {
		const before = reloadedKeeper();
		expect(before.take(true)).toBeNull();
		before.save(answeredChat());
		vi.advanceTimersByTime(TEMPORARY_CHAT_SAVE_DELAY_MS);

		const after = reloadedKeeper();
		expect(after.take(true)).toEqual(answeredChat());
		expect(after.take(true)).toBeNull();
	});

	it('writes nothing before the first take', () => {
		storage.setItem(TEMPORARY_CHAT_STORAGE_KEY, JSON.stringify(answeredChat()));
		const keeper = reloadedKeeper();
		keeper.save(chatWith({}));
		vi.advanceTimersByTime(TEMPORARY_CHAT_SAVE_DELAY_MS);
		keeper.flush();
		expect(keeper.take(true)).toEqual(answeredChat());
	});

	it('drops the kept chat once a new empty chat is saved', () => {
		storage.setItem(TEMPORARY_CHAT_STORAGE_KEY, JSON.stringify(answeredChat()));
		const keeper = reloadedKeeper();
		expect(keeper.take(true)).not.toBeNull();
		keeper.save(chatWith({}));
		vi.advanceTimersByTime(TEMPORARY_CHAT_SAVE_DELAY_MS);
		expect(storage.getItem(TEMPORARY_CHAT_STORAGE_KEY)).toBeNull();
	});

	it('drops the kept chat when temporary chat is off', () => {
		storage.setItem(TEMPORARY_CHAT_STORAGE_KEY, JSON.stringify(answeredChat()));
		expect(reloadedKeeper().take(false)).toBeNull();
		expect(storage.getItem(TEMPORARY_CHAT_STORAGE_KEY)).toBeNull();
	});

	it('drops a kept value it cannot read', () => {
		storage.setItem(TEMPORARY_CHAT_STORAGE_KEY, '{broken');
		expect(reloadedKeeper().take(true)).toBeNull();
		expect(storage.getItem(TEMPORARY_CHAT_STORAGE_KEY)).toBeNull();
	});

	it('writes at most once per delay, with the state as it is then', () => {
		const keeper = reloadedKeeper();
		keeper.take(true);
		const chat = answeredChat();
		const setItem = vi.spyOn(storage, 'setItem');
		keeper.save(chat);
		chat.history.messages.a.content = 'No, it is sinus rhythm.';
		keeper.save(chat);
		expect(setItem).not.toHaveBeenCalled();
		vi.advanceTimersByTime(TEMPORARY_CHAT_SAVE_DELAY_MS);
		expect(setItem).toHaveBeenCalledTimes(1);
		const kept = JSON.parse(storage.getItem(TEMPORARY_CHAT_STORAGE_KEY) ?? '{}');
		expect(kept.history.messages.a.content).toBe('No, it is sinus rhythm.');
	});

	it('writes a pending state at once when flushed', () => {
		const keeper = reloadedKeeper();
		keeper.take(true);
		keeper.save(answeredChat());
		keeper.flush();
		expect(reloadedKeeper().take(true)).toEqual(answeredChat());
	});

	it('drops the kept chat when the storage refuses a larger one', () => {
		const keeper = reloadedKeeper();
		keeper.take(true);
		keeper.save(answeredChat());
		keeper.flush();
		storage.limit = 10;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		keeper.save(answeredChat());
		keeper.flush();
		expect(warn).toHaveBeenCalledOnce();
		expect(storage.getItem(TEMPORARY_CHAT_STORAGE_KEY)).toBeNull();
		warn.mockRestore();
	});

	it('does nothing without a storage', () => {
		const keeper = createTemporaryChatKeeper(() => null);
		expect(keeper.take(true)).toBeNull();
		keeper.save(answeredChat());
		keeper.flush();
	});
});
