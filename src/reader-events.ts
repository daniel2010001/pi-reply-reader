/**
 * The event contract other Pi extensions use to reach the reader over Pi's shared event bus (`pi.events`), S10.
 * No package depends on the other, so the channel names and the payload version live only here.
 */

/** The payload version both sides send; a payload with any other `v` is ignored. */
export const READER_EVENTS_VERSION = 1;

/** The channels of contract v1. */
export const READER_EVENTS = {
	/** `{ v: 1 }`: is a reader there? Answered at once with `ready`. */
	ping: "reply-reader:ping",
	/** `{ v: 1 }`: the reader is there; also sent at every session start. */
	ready: "reply-reader:ready",
	/** `{ v: 1, id, text }`: read `text` (Markdown) aloud, naming `id` in the footer and messages. */
	read: "reply-reader:read",
} as const;

/** What `ping` and `ready` carry. */
export interface ReaderPresence {
	v: typeof READER_EVENTS_VERSION;
}

/** What `read` carries. */
export interface ReadRequest {
	v: typeof READER_EVENTS_VERSION;
	id: string;
	text: string;
}

const isObject = (data: unknown): data is Record<string, unknown> => typeof data === "object" && data !== null && !Array.isArray(data);

/** Whether `data` is a v1 ping (an object with `v` 1). */
export function isPing(data: unknown): data is ReaderPresence {
	return isObject(data) && data.v === READER_EVENTS_VERSION;
}

/** The read request in `data`, or undefined unless it is an object with `v` 1 and non-empty string `id` and `text`. */
export function parseReadRequest(data: unknown): ReadRequest | undefined {
	if (!isObject(data) || data.v !== READER_EVENTS_VERSION) return undefined;
	const { id, text } = data;
	if (typeof id !== "string" || typeof text !== "string" || id === "" || text === "") return undefined;
	return { v: READER_EVENTS_VERSION, id, text };
}
