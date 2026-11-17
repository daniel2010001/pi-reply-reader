import { describe, expect, it } from "vitest";
import { isPing, parseReadRequest, READER_EVENTS, READER_EVENTS_VERSION } from "../src/reader-events.ts";

describe("reader event contract v1 (S10)", () => {
	it("pins the channel names and the payload version agreed with pi-reply-thread", () => {
		expect(READER_EVENTS).toEqual({ ping: "reply-reader:ping", ready: "reply-reader:ready", read: "reply-reader:read" });
		expect(READER_EVENTS_VERSION).toBe(1);
	});

	it("a ping is an object with v 1; extra keys are allowed", () => {
		expect(isPing({ v: 1 })).toBe(true);
		expect(isPing({ v: 1, from: "pi-reply-thread" })).toBe(true);
		for (const data of [undefined, null, 1, "v1", [1], {}, { v: 2 }, { v: "1" }]) expect(isPing(data)).toBe(false);
	});

	it("a read request keeps only v, id and text, and needs non-empty strings", () => {
		expect(parseReadRequest({ v: 1, id: "P3.R1.Q2", text: "## Hola", extra: true })).toEqual({ v: 1, id: "P3.R1.Q2", text: "## Hola" });
		const invalid = [
			undefined,
			null,
			"Hola.",
			[{ v: 1, id: "a", text: "b" }],
			{},
			{ v: 2, id: "a", text: "b" },
			{ v: "1", id: "a", text: "b" },
			{ v: 1, text: "b" },
			{ v: 1, id: "a" },
			{ v: 1, id: "", text: "b" },
			{ v: 1, id: "a", text: "" },
			{ v: 1, id: 7, text: "b" },
			{ v: 1, id: "a", text: ["b"] },
		];
		for (const data of invalid) expect(parseReadRequest(data)).toBeUndefined();
	});
});
