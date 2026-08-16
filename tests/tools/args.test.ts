import { describe, expect, it } from "vitest";
import {
	defined,
	metadataOf,
	num,
	optNum,
	optScope,
	optStr,
	scopeOf,
	str,
	strArray,
} from "../../src/tools/args.ts";

describe("str", () => {
	it("passes a string through", () => {
		expect(str("hello")).toBe("hello");
		expect(str("")).toBe("");
	});

	it("uses the fallback for absence", () => {
		expect(str(undefined)).toBe("");
		expect(str(null)).toBe("");
		expect(str(undefined, "fallback")).toBe("fallback");
	});

	it("stringifies anything else rather than throwing", () => {
		expect(str(42)).toBe("42");
		expect(str(true)).toBe("true");
	});
});

describe("optStr", () => {
	it("is present only for a real string", () => {
		expect(optStr("x")).toBe("x");
		expect(optStr(7)).toBeUndefined();
		expect(optStr(undefined)).toBeUndefined();
		expect(optStr(null)).toBeUndefined();
	});
});

describe("optNum and num", () => {
	it("accepts a finite number", () => {
		expect(optNum(5)).toBe(5);
		expect(optNum(0)).toBe(0);
		expect(num(5)).toBe(5);
	});

	it("rejects a numeric string, rather than parsing it", () => {
		// Coercing "5" works right up until the day something sends "5 " or
		// "five", and by then nobody remembers this was allowed.
		expect(optNum("5")).toBeUndefined();
		expect(num("5", 9)).toBe(9);
	});

	it("rejects the non-finite values that are technically numbers", () => {
		expect(optNum(Number.NaN)).toBeUndefined();
		expect(optNum(Number.POSITIVE_INFINITY)).toBeUndefined();
	});
});

describe("strArray", () => {
	it("is present only for an array", () => {
		expect(strArray(["a", "b"])).toEqual(["a", "b"]);
		expect(strArray("a")).toBeUndefined();
		expect(strArray(undefined)).toBeUndefined();
	});

	it("stringifies the members", () => {
		expect(strArray([1, "two", null])).toEqual(["1", "two", ""]);
	});

	it("keeps an empty array distinct from absence", () => {
		expect(strArray([])).toEqual([]);
	});
});

describe("metadataOf", () => {
	it("keeps string values and normalizes scalar side attributes", () => {
		expect(
			metadataOf({ source: "catalog", version: 2, enabled: true }),
		).toEqual({ source: "catalog", version: "2", enabled: "true" });
	});

	it("does not turn nested values into misleading strings", () => {
		expect(
			metadataOf({ source: "catalog", nested: { id: 1 }, list: ["x"] }),
		).toEqual({ source: "catalog" });
		expect(metadataOf({ nested: { id: 1 }, list: ["x"] })).toBeUndefined();
		expect(metadataOf([])).toBeUndefined();
	});

	it("keeps an explicit empty map distinct from omission", () => {
		expect(metadataOf({})).toEqual({});
		expect(metadataOf(undefined)).toBeUndefined();
	});
});

describe("scopeOf", () => {
	it("accepts the three real scopes", () => {
		expect(scopeOf("project")).toBe("project");
		expect(scopeOf("user")).toBe("user");
		expect(scopeOf("both")).toBe("both");
	});

	it("sends anything else to the project, never to the shared memory", () => {
		// The asymmetry that decides this: a wrong fact in a project memory
		// never surfaces elsewhere, while a wrong one in the shared memory is
		// read at the start of every session of every project.
		expect(scopeOf("global")).toBe("project");
		expect(scopeOf(undefined)).toBe("project");
		expect(scopeOf(null)).toBe("project");
		expect(scopeOf(1)).toBe("project");
	});
});

describe("optScope", () => {
	it("is absent when nothing usable was given", () => {
		expect(optScope("user")).toBe("user");
		expect(optScope("nonsense")).toBeUndefined();
	});
});

describe("defined", () => {
	it("drops undefined values and keeps everything else", () => {
		expect(defined({ a: 1, b: undefined, c: null, d: 0, e: "" })).toEqual({
			a: 1,
			c: null,
			d: 0,
			e: "",
		});
	});

	it("returns an empty object when everything is absent", () => {
		expect(defined({ a: undefined })).toEqual({});
	});

	it("does not mutate its input", () => {
		const source = { a: 1, b: undefined };
		defined(source);
		expect(Object.keys(source)).toEqual(["a", "b"]);
	});
});
