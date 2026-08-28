// src/index.spec.mjs
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute, schedule, setDryRun } from "./index.mjs";

const createMockDevice = (data = { updated: "2026-08-28T00:00:00.000Z", value: 1 }) => ({
	name: "TestDevice",
	update: vi.fn().mockResolvedValue(data),
});

const createMockCache = (initial = []) => {
	let readings = [...initial];
	return {
		get all() {
			return [...readings];
		},
		add: vi.fn((reading) => readings.push(reading)),
		clear: vi.fn(() => {
			readings = [];
		}),
	};
};

const createMockHook = (result = { exitCode: 0, message: "Data sent successfully" }) => ({
	send: vi.fn().mockResolvedValue(result),
	connect: vi.fn().mockResolvedValue(undefined),
	uploadInterval: 60,
});

describe("index", () => {
	beforeEach(() => {
		setDryRun(false);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("execute", () => {
		it("reads once, caches the reading and sends it, clearing the cache on success", async () => {
			const device = createMockDevice();
			const cache = createMockCache();
			const hook = createMockHook();

			await execute(device, hook, cache);

			expect(device.update).toHaveBeenCalledTimes(1);
			expect(cache.add).toHaveBeenCalledWith({ updated: "2026-08-28T00:00:00.000Z", value: 1 });
			expect(hook.send).toHaveBeenCalledWith([{ updated: "2026-08-28T00:00:00.000Z", value: 1 }], false);
			expect(cache.clear).toHaveBeenCalled();
		});

		it("keeps the cache when sending fails", async () => {
			const device = createMockDevice();
			const cache = createMockCache();
			const hook = createMockHook({ exitCode: 1, message: "failed" });

			await execute(device, hook, cache);

			expect(cache.clear).not.toHaveBeenCalled();
		});
	});

	describe("schedule", () => {
		it("reads and sends immediately, then keeps reading independently of the send/upload interval", async () => {
			vi.useFakeTimers();
			const device = createMockDevice();
			const cache = createMockCache();
			const hook = createMockHook();

			await schedule(device, hook, cache);

			expect(device.update).toHaveBeenCalledTimes(1);
			expect(hook.connect).toHaveBeenCalledTimes(1);
			expect(hook.send).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // default read interval

			expect(device.update).toHaveBeenCalledTimes(2);
			expect(hook.send.mock.calls.length).toBeGreaterThanOrEqual(2); // at least one send once new data was cached
		});

		it("does not send when there's nothing cached", async () => {
			vi.useFakeTimers();
			const device = createMockDevice();
			const cache = createMockCache();
			const hook = createMockHook();
			cache.clear(); // ensure nothing is queued before scheduling

			await schedule(device, hook, cache);
			hook.send.mockClear();
			cache.clear();

			await vi.advanceTimersByTimeAsync(60_000); // one send tick, cache empty

			expect(hook.send).not.toHaveBeenCalled();
		});
	});
});
