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
	 * `waited` is true when a reading played while it waited in the line (S14: it then starts after a gap, announced).
	 */
	start: (item: T, current: () => boolean, waited: boolean) => Promise<StartResult>;
	/** How often a waiting line checks again whether the machine is free. */
	retryMs: number;
	/** Called whenever the line changes (S16: the session publishes it for /read-queue and the footer). */
	onChange?: () => void;
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
	/** The replies waiting, in order (S16). */
	readonly items: readonly T[];
	/**
	 * The reply being started, until its start settles (S16: it keeps its place in the machine's list meanwhile); once
	 * clear() dropped it, undefined even while its start is still in flight (an output question left open, L138).
	 */
	readonly starting: T | undefined;
}

export function createAutoQueue<T>(options: AutoQueueOptions<T>): AutoQueue<T> {
	/** The line, in order; `waited` is set once a reading played while the item waited (S14). */
	let items: { item: T; waited: boolean }[] = [];
	/** Bumped by clear(); a start begun under an older generation is no longer current. */
	let generation = 0;
	/** The reply whose start is in flight, with the generation it started under; only one at a time. */
	let starting: { item: T; generation: number } | undefined;
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
		if (options.busy()) {
			for (const entry of items) entry.waited = true;
			return later();
		}
		const entry = items.shift() as { item: T; waited: boolean };
		const { item } = entry;
		const mine = generation;
		const current = () => mine === generation;
		starting = { item, generation: mine };
		options.onChange?.();
		const attempt = (async () => options.start(item, current, entry.waited))().catch((): StartResult => "done");
		void attempt.then((result) => {
			starting = undefined;
			if (result === "busy" && current()) {
				// Taken between the check and the claim: try again on the next check, not in a tight loop. It waits for
				// that reading too.
				items.unshift({ item, waited: true });
				options.onChange?.();
				return later();
			}
			options.onChange?.();
			// The reading just started makes the machine busy, so the next reply waits for it; anything pushed while this
			// start was in flight is looked at now.
			pump();
		});
	};

	return {
		push(item) {
			items.push({ item, waited: false });
			options.onChange?.();
			pump();
		},
		clear(keep) {
			items = keep ? items.filter((entry) => keep(entry.item)) : [];
			// Before onChange, so the line published then no longer lists a dropped reply still starting.
			if (!keep || !starting || !keep(starting.item)) generation++;
			options.onChange?.();
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
		get items() {
			return items.map((entry) => entry.item);
		},
		get starting() {
			return starting && starting.generation === generation ? starting.item : undefined;
		},
	};
}
