// src/config/config.spec.mjs
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "./config.mjs";

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

import * as fs from "node:fs";

const CONFIG_FILE = "./config/config.json";

describe("Config", () => {
	beforeEach(() => {
		fs.readFileSync.mockReset();
		fs.writeFileSync.mockReset();
		fs.mkdirSync.mockReset();
	});

	it("creates the config folder/file with an empty object when none exists", () => {
		const error = new Error("ENOENT");
		error.code = "ENOENT";
		fs.readFileSync.mockImplementation(() => {
			throw error;
		});

		new Config(CONFIG_FILE);

		expect(fs.mkdirSync).toHaveBeenCalledWith("./config", { recursive: true });
		expect(fs.writeFileSync).toHaveBeenCalledWith(CONFIG_FILE, "{}");
	});

	it("rethrows unexpected read errors instead of silently overwriting the file", () => {
		fs.readFileSync.mockImplementation(() => {
			throw new Error("Permission denied");
		});

		expect(() => new Config(CONFIG_FILE)).toThrow("Permission denied");
		expect(fs.writeFileSync).not.toHaveBeenCalled();
	});

	it("reads nested values via dot-notation", () => {
		fs.readFileSync.mockReturnValue('{ "energyid": { "provisioningKey": "abc" } }');

		const config = new Config(CONFIG_FILE);

		expect(config.get("energyid.provisioningKey")).toBe("abc");
		expect(config.get("energyid.missing", "fallback")).toBe("fallback");
		expect(config.get("missing.nested")).toBeUndefined();
	});

	it("sets nested values, creating intermediate objects, and persists immediately", () => {
		fs.readFileSync.mockReturnValue("{}");
		const config = new Config(CONFIG_FILE);

		config.set("energyid.provisioningKey", "xyz");

		expect(config.get("energyid.provisioningKey")).toBe("xyz");
		expect(fs.writeFileSync).toHaveBeenCalledWith(
			CONFIG_FILE,
			JSON.stringify({ energyid: { provisioningKey: "xyz" } }, null, 2),
		);
	});
});
