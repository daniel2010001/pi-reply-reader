/**
 * One session's auto-read line (S8 Queue, T32): replies due for auto-read wait here, in order, while a reading plays
 * in this session or anywhere on the machine, and start one at a time once it is free. Auto-read never interrupts.
 */

/** "busy": the machine was taken before the reply could start, so it stays first in line; "done": it is used up. */
export type StartResult = "busy" | "done";

export interface AutoQueueOptions<T> {
	/** Whether a reading plays (or is about to) in this session or on the machine. */
	busy: () => boolean;
	/**
	 * Starts `item`; resolves once its reading is under way, or was cancelled or dropped. `current()` turns false when
	 * the line is cleared meanwhile, so a reply still starting (an output question, a download confirm) must not play.
	 */
	start: (item: T, current: () => boolean) => Promise<StartResult>;
	/** How often a waiting line checks again whether the machine is free. */
	retryMs: number;
}

export interface AutoQueue<T> {
	/** Adds a reply at the end of the line, starting it at once when nothing plays. */
	push(item: T): void;
	/**
	 * Drops every waiting reply and the one being started (the session's end, an explicit action). With `keep`, only
	 * those it rejects (/read-auto off keeps a manual request waiting after "Read after it", T33).
	 */
	clear(keep?: (item: T) => boolean): void;
	/** Checks the line again now, as when this session's reading ended. */
	kick(): void;
	/** How many replies wait. */
	readonly size: number;
}

export function createAutoQueue<T>(options: AutoQueueOptions<T>): AutoQueue<T> {
	let items: T[] = [];
	/** Bumped by clear(); a start begun under an older generation is no longer current. */
	let generation = 0;
	/** The reply whose start is in flight; only one at a time. */
	let starting: { item: T } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const later = (): void => {
		if (timer || items.length === 0) return;
		timer = setTimeout(() => {
			timer = undefined;
			pump();
		}, options.retryMs);
		timer.unref?.();
	};

	const pump = (): void => {
		if (starting || items.length === 0) return;
		if (options.busy()) return later();
		const item = items.shift() as T;
		const mine = generation;
		const current = () => mine === generation;
		starting = { item };
		const attempt = (async () => options.start(item, current))().catch((): StartResult => "done");
		void attempt.then((result) => {
			starting = undefined;
			if (result === "busy" && current()) {
				// Taken between the check and the claim: try again on the next check, not in a tight loop.
				items.unshift(item);
				return later();
			}
			// The reading just started makes the machine busy, so the next reply waits for it; anything pushed while this
			// start was in flight is looked at now.
			pump();
		});
	};

	return {
		push(item) {
			items.push(item);
			pump();
		},
		clear(keep) {
			items = keep ? items.filter(keep) : [];
			if (!keep || !starting || !keep(starting.item)) generation++;
			clearTimeout(timer);
			timer = undefined;
			// Kept replies still wait for the machine.
			later();
		},
		kick() {
			clearTimeout(timer);
			timer = undefined;
			pump();
		},
		get size() {
			return items.length;
		},
	};
}
