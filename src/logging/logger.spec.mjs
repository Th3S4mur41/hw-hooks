import { afterEach, describe, expect, it, vi } from "vitest";

const createStream = vi.fn(() => ({ end: vi.fn(), once: vi.fn() }));

vi.mock("rotating-file-stream", () => ({ createStream }));

const { createLogger, isFileLoggingEnabled, resolveLogLevel } = await import("./logger.mjs");

describe("logger", () => {
	afterEach(() => {
		createStream.mockClear();
	});

	it("prefers the CLI log level over the environment and default", () => {
		expect(resolveLogLevel("debug", "warn")).toBe("debug");
		expect(resolveLogLevel(undefined, "warn")).toBe("warn");
		expect(resolveLogLevel()).toBe("info");
	});

	it("rejects invalid log levels", () => {
		expect(() => resolveLogLevel("verbose")).toThrow('Invalid log level "verbose"');
	});

	it("suppresses records below the configured level", () => {
		const { logger } = createLogger({ level: "warn" });

		expect(logger.isLevelEnabled("info")).toBe(false);
		expect(logger.isLevelEnabled("warn")).toBe(true);
	});

	it("enables file logging only when explicitly requested", () => {
		expect(isFileLoggingEnabled(true)).toBe(true);
		expect(isFileLoggingEnabled("true")).toBe(true);
		expect(isFileLoggingEnabled("false")).toBe(false);
		expect(isFileLoggingEnabled(undefined)).toBe(false);
	});

	it("configures a daily compressed log file with seven retained files", () => {
		const { logger } = createLogger({ fileEnabled: true, filePath: "/tmp/hw-hooks.log" });

		expect(logger.level).toBe("info");
		expect(createStream).toHaveBeenCalledWith("hw-hooks.log", {
			interval: "1d",
			maxFiles: 7,
			compress: "gzip",
			path: "/tmp",
		});
	});
});
