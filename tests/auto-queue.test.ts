import { describe, expect, it } from "vitest";
import { createAutoQueue, type StartResult } from "../src/auto-queue.ts";

/** T32 (S8 Queue): one session's auto-read waiting line, apart from how readings play. */

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A queue whose machine is busy while `state.busy` is set, recording each start; `answer` decides each start. */
function make(answer: (item: string) => StartResult | Promise<StartResult> = () => "done") {
	const state = { busy: false, started: [] as string[], current: [] as (() => boolean)[] };
	const queue = createAutoQueue<string>({
		busy: () => state.busy,
		start: async (item, current) => {
			state.started.push(item);
			state.current.push(current);
			return answer(item);
		},
		retryMs: 30,
	});
	return { queue, state };
}

describe("auto-read queue (T32, S8)", () => {
	it("starts a reply at once when the machine is free, and the next ones in order", async () => {
		const { queue, state } = make();
		queue.push("P3");
		queue.push("P4");
		queue.push("P5");
		await tick();
		expect(state.started).toEqual(["P3", "P4", "P5"]);
		expect(queue.size).toBe(0);
	});

	it("waits while the machine is busy, checks again on its own, and at once on kick", async () => {
		const { queue, state } = make();
		state.busy = true;
		queue.push("P3");
		await tick(80);
		expect(state.started).toEqual([]);
		state.busy = false;
		await tick(60);
		expect(state.started).toEqual(["P3"]);
		state.busy = true;
		queue.push("P4");
		await tick(5);
		state.busy = false;
		queue.kick();
		await tick();
		expect(state.started).toEqual(["P3", "P4"]);
	});

	it("starts one reply at a time: the next waits until the one starting is under way and the machine is free", async () => {
		let release!: () => void;
		const { queue, state } = make((item) => (item === "P3" ? new Promise<StartResult>((done) => (release = () => done("done"))) : "done"));
		queue.push("P3");
		queue.push("P4");
		await tick(50);
		expect(state.started).toEqual(["P3"]);
		state.busy = true;
		release();
		await tick(50);
		expect(state.started).toEqual(["P3"]);
		state.busy = false;
		await tick(50);
		expect(state.started).toEqual(["P3", "P4"]);
	});

	it("a start that finds the machine taken keeps the reply first in line", async () => {
		let taken = true;
		const { queue, state } = make((item) => (item === "P3" && taken ? ((taken = false), "busy") : "done"));
		queue.push("P3");
		queue.push("P4");
		await tick(80);
		expect(state.started).toEqual(["P3", "P3", "P4"]);
	});

	it("clear drops every waiting reply and the one being started; replies pushed later are read", async () => {
		let release!: () => void;
		const { queue, state } = make((item) => (item === "P3" ? new Promise<StartResult>((done) => (release = () => done("done"))) : "done"));
		queue.push("P3");
		queue.push("P4");
		await tick();
		expect(state.current[0]()).toBe(true);
		queue.clear();
		expect(state.current[0]()).toBe(false);
		expect(queue.size).toBe(0);
		queue.push("P5");
		release();
		await tick(50);
		expect(state.started).toEqual(["P3", "P5"]);
	});

	it("clear(keep) drops only what keep rejects, the one being started too, and the kept ones still wait their turn in order (T33)", async () => {
		let release!: () => void;
		const { queue, state } = make((item) => (item === "auto-1" ? new Promise<StartResult>((done) => (release = () => done("done"))) : "done"));
		queue.push("auto-1");
		state.busy = true;
		queue.push("manual-1");
		queue.push("auto-2");
		queue.push("manual-2");
		await tick();
		queue.clear((item) => item.startsWith("manual"));
		expect(state.current[0]()).toBe(false);
		expect(queue.size).toBe(2);
		release();
		await tick(80);
		expect(state.started).toEqual(["auto-1"]);
		state.busy = false;
		await tick(80);
		expect(state.started).toEqual(["auto-1", "manual-1", "manual-2"]);
	});

	it("clear(keep) leaves a kept reply being started current", async () => {
		let release!: () => void;
		const { queue, state } = make((item) => (item === "manual-1" ? new Promise<StartResult>((done) => (release = () => done("done"))) : "done"));
		queue.push("manual-1");
		queue.push("auto-1");
		await tick();
		queue.clear((item) => item.startsWith("manual"));
		expect(state.current[0]()).toBe(true);
		expect(queue.size).toBe(0);
		release();
		await tick(50);
		expect(state.started).toEqual(["manual-1"]);
	});

	it("a failing start counts as done and the line goes on", async () => {
		const { queue, state } = make((item) => {
			if (item === "P3") throw new Error("boom");
			return "done";
		});
		queue.push("P3");
		queue.push("P4");
		await tick(20);
		expect(state.started).toEqual(["P3", "P4"]);
	});
});
