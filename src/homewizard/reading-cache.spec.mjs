// src/homewizard/reading-cache.spec.mjs
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingCache } from "./reading-cache.mjs";

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

import * as fs from "node:fs";

const CACHE_FILE = "./config/.cache.json";

describe("ReadingCache", () => {
	beforeEach(() => {
		fs.readFileSync.mockReset();
		fs.writeFileSync.mockReset();
		fs.mkdirSync.mockReset();
	});

	it("starts empty when no cache file exists", () => {
		const error = new Error("ENOENT");
		error.code = "ENOENT";
		fs.readFileSync.mockImplementation(() => {
			throw error;
		});

		const cache = new ReadingCache(CACHE_FILE);

		expect(cache.all).toEqual([]);
	});

	it("loads previously cached readings from disk", () => {
		fs.readFileSync.mockReturnValue(JSON.stringify([{ updated: "2026-08-28T00:00:00.000Z", value: 1 }]));

		const cache = new ReadingCache(CACHE_FILE);

		expect(cache.all).toEqual([{ updated: "2026-08-28T00:00:00.000Z", value: 1 }]);
	});

	it("adds a reading and persists the updated cache", () => {
		fs.readFileSync.mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		const cache = new ReadingCache(CACHE_FILE);

		cache.add({ updated: "2026-08-28T00:05:00.000Z", value: 2 });

		expect(cache.all).toEqual([{ updated: "2026-08-28T00:05:00.000Z", value: 2 }]);
		expect(fs.writeFileSync).toHaveBeenCalledWith(
			CACHE_FILE,
			JSON.stringify([{ updated: "2026-08-28T00:05:00.000Z", value: 2 }], null, 2),
		);
	});

	it("removes only the sent readings, keeping readings added while sending", () => {
		fs.readFileSync.mockReturnValue(JSON.stringify([{ value: 1 }, { value: 2 }]));
		const cache = new ReadingCache(CACHE_FILE);
		const sending = cache.all;

		cache.add({ value: 3 });
		cache.remove(sending);

		expect(cache.all).toEqual([{ value: 3 }]);
	});

	it("clears all readings and persists an empty cache", () => {
		fs.readFileSync.mockReturnValue(JSON.stringify([{ value: 1 }]));
		const cache = new ReadingCache(CACHE_FILE);

		cache.clear();

		expect(cache.all).toEqual([]);
		expect(fs.writeFileSync).toHaveBeenCalledWith(CACHE_FILE, "[]");
	});

	it("returns a copy of the readings, not a live reference", () => {
		fs.readFileSync.mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		const cache = new ReadingCache(CACHE_FILE);

		cache.all.push({ value: "should not persist" });

		expect(cache.all).toEqual([]);
	});
});
