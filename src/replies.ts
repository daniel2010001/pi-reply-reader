import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface Reply {
	/** `P<prompt>.R<n>`, numbered exactly like pi-reply-thread's `/replies`. */
	id: string;
	/** The Pi session entry ID of the assistant message. */
	entryId: string;
	text: string;
}

/** Stop reasons of an assistant message that finished speaking instead of calling tools or failing. */
const FINISHED = new Set(["stop", "length"]);

/** gentle-agents wakes the session with a user-role message; it is not a prompt. */
const WAKE_PREFIX = "[System-generated Gentle Agents notification, not written by the user]";

type Content = string | readonly { type: string; text?: string }[] | undefined;

function textOf(content: Content): string {
	if (typeof content === "string") return content;
	if (!content) return "";
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * The final replies of a session branch (pass `ctx.sessionManager.getBranch()`), numbered under the prompt
 * that preceded them. Replies before any prompt fall under P0.
 */
export function listReplies(entries: readonly SessionEntry[]): Reply[] {
	const replies: Reply[] = [];
	let prompt = 0;
	let index = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: Content; stopReason?: string };
		if (message.role === "user") {
			if (textOf(message.content).startsWith(WAKE_PREFIX)) continue;
			prompt += 1;
			index = 0;
			continue;
		}
		if (message.role !== "assistant" || !FINISHED.has(message.stopReason ?? "")) continue;
		const text = textOf(message.content).trim();
		if (!text) continue;
		index += 1;
		replies.push({ id: `P${prompt}.R${index}`, entryId: entry.id, text });
	}
	return replies;
}

/** By ordered ID in any case (a `.Q<n>` question suffix is accepted) or by exact entry ID. */
export function findReply(replies: readonly Reply[], id: string): Reply | undefined {
	const wanted = id.trim();
	if (!wanted) return undefined;
	const ordered = /^(p\d+\.r\d+)(?:\.q\d+)?$/i.exec(wanted)?.[1].toUpperCase();
	return replies.find((reply) => reply.id === ordered || reply.entryId === wanted);
}

export function latestReply(replies: readonly Reply[]): Reply | undefined {
	return replies.at(-1);
}
