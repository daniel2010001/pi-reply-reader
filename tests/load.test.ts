import { expect, it } from "vitest";
import replyReader from "../extensions/reply-reader.ts";

it("loads without registering anything yet", () => {
	const calls: string[] = [];
	const pi = new Proxy({}, { get: (_target, name) => () => calls.push(String(name)) });
	replyReader(pi as never);
	expect(calls).toEqual([]);
});
