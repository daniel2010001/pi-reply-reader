import { describe, expect, it } from "vitest";
import { findReply, latestReply, listReplies } from "../src/replies.ts";

let next = 0;
const user = (text: string) => ({ type: "message", id: `u${++next}`, timestamp: "t", message: { role: "user", content: text } });
const assistant = (text: string, stopReason = "stop") => ({
	type: "message",
	id: `a${++next}`,
	timestamp: "t",
	message: { role: "assistant", stopReason, content: [{ type: "thinking", thinking: "x" }, { type: "text", text }] },
});
const wake = () => user("[System-generated Gentle Agents notification, not written by the user] job done");

describe("listReplies", () => {
	it("numbers final replies under their prompt like pi-reply-thread", () => {
		const entries = [
			assistant("antes de todo"),
			user("hola"),
			assistant("llamo una herramienta", "toolUse"),
			assistant("primera"),
			{ type: "custom_message", id: "c1", timestamp: "t", customType: "gentle-jobs.notice", display: true, content: "Background job x" },
			wake(),
			assistant("segunda"),
			assistant("   ", "stop"),
			user("otra"),
			assistant("tercera", "length"),
			assistant("fall\u00f3", "error"),
		];
		expect(listReplies(entries as never).map((r) => [r.id, r.text])).toEqual([
			["P0.R1", "antes de todo"],
			["P1.R1", "primera"],
			["P1.R2", "segunda"],
			["P2.R1", "tercera"],
		]);
	});
});

describe("findReply", () => {
	const replies = listReplies([user("a"), assistant("uno"), assistant("dos"), user("b"), assistant("tres")] as never);

	it("finds a reply by ordered ID in any case, with or without a question suffix", () => {
		expect(findReply(replies, "p1.r2")?.text).toBe("dos");
		expect(findReply(replies, "P1.R2.Q1")?.text).toBe("dos");
		expect(findReply(replies, " P2.R1 ")?.text).toBe("tres");
	});

	it("finds a reply by its Pi entry ID", () => {
		expect(findReply(replies, replies[0].entryId)?.text).toBe("uno");
	});

	it("finds nothing for an unknown ID", () => {
		expect(findReply(replies, "P9.R1")).toBeUndefined();
		expect(findReply(replies, "")).toBeUndefined();
	});

	it("takes the latest reply, or nothing on an empty branch", () => {
		expect(latestReply(replies)?.id).toBe("P2.R1");
		expect(latestReply([])).toBeUndefined();
	});
});
