// src/webhooks/energyid.spec.mjs
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnergyIdWebhook } from "./energyid.mjs";

vi.mock("node:crypto", () => ({
	randomUUID: vi.fn(),
}));

import { randomUUID } from "node:crypto";

globalThis.fetch = vi.fn();

/**
 * A minimal in-memory stand-in for Config, using flat dot-path keys (matching how EnergyIdWebhook calls it)
 */
const createMockConfig = (initial = {}, { withCredentials = true } = {}) => {
	const store = {
		...(withCredentials
			? { "energyid.provisioningKey": "stored-key", "energyid.provisioningSecret": "stored-secret" }
			: {}),
		...initial,
	};
	return {
		get: vi.fn((key, defaultValue) => (store[key] === undefined ? defaultValue : store[key])),
		set: vi.fn((key, value) => {
			store[key] = value;
		}),
	};
};

const mockMapping = {
	total_power_import_t1_kwh: "el.t1",
	total_liter_m3: "dw",
};

const mockReading = {
	total_power_import_t1_kwh: 123.45,
	total_liter_m3: 67.89,
	updated: "2026-08-27T12:00:00.000Z",
};

const mockClaimResponse = {
	claimCode: "4H7A70",
	claimUrl: "https://app.energyid.eu/integrations/webhook-in/new?code=4H7A70",
	exp: 1691402519,
};

const mockConnectionResponse = {
	webhookUrl: "https://hooks.energyid.eu/webhook-in",
	headers: {
		authorization: "SharedAccessSignature sr=...",
		"x-twin-id": "00000000-0000-0000-0000-000000000000",
	},
	webhookPolicy: { uploadInterval: 60 },
	recordName: "My home",
	recordNumber: "EA-12345678",
};

describe("EnergyIdWebhook", () => {
	let uuidCounter;

	beforeEach(() => {
		fetch.mockReset();
		uuidCounter = 0;
		randomUUID.mockReset();
		randomUUID.mockImplementation(() => `uuid-${uuidCounter++}`);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("persists the provisioning credentials passed in", () => {
		const config = createMockConfig({
			"homewizard.serial": "SERIAL123",
			"homewizard.name": "P1 meter",
			"homewizard.firmwareVersion": "4.0.0",
		});

		new EnergyIdWebhook(
			"TestEnergyId",
			{ config, provisioningKey: "my-key", provisioningSecret: "my-secret" },
			mockMapping,
		);

		expect(config.set).toHaveBeenCalledWith("energyid.provisioningKey", "my-key");
		expect(config.set).toHaveBeenCalledWith("energyid.provisioningSecret", "my-secret");
	});

	it("throws when no provisioning credentials are given or stored", () => {
		const config = createMockConfig({ "homewizard.serial": "SERIAL123" }, { withCredentials: false });

		expect(() => new EnergyIdWebhook("TestEnergyId", { config }, mockMapping)).toThrow(
			/Missing EnergyID provisioning credentials/,
		);
	});

	it("provisions the device (including firmwareVersion) and sends a single reading", async () => {
		fetch
			.mockResolvedValueOnce({ ok: true, json: async () => mockConnectionResponse })
			.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
		const config = createMockConfig({
			"homewizard.serial": "SERIAL123",
			"homewizard.name": "P1 meter",
			"homewizard.firmwareVersion": "4.0.0",
		});

		const webhook = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);
		const result = await webhook.send(mockReading);

		expect(fetch).toHaveBeenNthCalledWith(1, "https://hooks.energyid.eu/hello", {
			method: "POST",
			headers: expect.objectContaining({
				"X-Provisioning-Key": "stored-key",
				"X-Provisioning-Secret": "stored-secret",
			}),
			body: JSON.stringify({ deviceId: "SERIAL123", deviceName: "P1 meter", firmwareVersion: "4.0.0" }),
		});
		expect(fetch).toHaveBeenNthCalledWith(2, mockConnectionResponse.webhookUrl, {
			method: "POST",
			headers: { ...mockConnectionResponse.headers, "Content-Type": "application/json" },
			body: JSON.stringify({ "el.t1": 123.45, dw: 67.89, ts: Math.floor(Date.parse(mockReading.updated) / 1000) }),
		});
		expect(result).toEqual({ exitCode: 0, message: "Data sent successfully" });
		expect(webhook.uploadInterval).toBe(60);
	});

	it("sends an array of cached readings as a batch payload", async () => {
		fetch
			.mockResolvedValueOnce({ ok: true, json: async () => mockConnectionResponse })
			.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
		const config = createMockConfig();

		const webhook = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);
		const secondReading = { ...mockReading, total_power_import_t1_kwh: 200, updated: "2026-08-27T12:05:00.000Z" };
		const result = await webhook.send([mockReading, secondReading]);

		expect(fetch).toHaveBeenNthCalledWith(2, mockConnectionResponse.webhookUrl, {
			method: "POST",
			headers: { ...mockConnectionResponse.headers, "Content-Type": "application/json" },
			body: JSON.stringify([
				{ "el.t1": 123.45, dw: 67.89, ts: Math.floor(Date.parse(mockReading.updated) / 1000) },
				{ "el.t1": 200, dw: 67.89, ts: Math.floor(Date.parse(secondReading.updated) / 1000) },
			]),
		});
		expect(result).toEqual({ exitCode: 0, message: "Data sent successfully" });
	});

	it("persists the last send and keeps throttling after a restart", async () => {
		fetch
			.mockResolvedValueOnce({ ok: true, json: async () => mockConnectionResponse })
			.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
		const config = createMockConfig();

		await new EnergyIdWebhook("TestEnergyId", { config }, mockMapping).send(mockReading);
		expect(config.set).toHaveBeenCalledWith("energyid.lastSentAt", expect.any(String));

		fetch.mockClear();
		const restarted = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);
		const result = await restarted.send(mockReading);

		expect(fetch).not.toHaveBeenCalled();
		expect(result.exitCode).toBe(2);
	});

	it("skips sending when no reading in the batch matches the mapping", async () => {
		const config = createMockConfig();
		const webhook = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);

		const result = await webhook.send([{ updated: mockReading.updated }]);

		expect(fetch).not.toHaveBeenCalled();
		expect(result).toEqual({ exitCode: 1, message: "No data matching the mapping. Skipping send." });
	});

	it("polls /hello until the device is claimed", async () => {
		vi.useFakeTimers();
		fetch
			.mockResolvedValueOnce({ ok: true, json: async () => mockClaimResponse })
			.mockResolvedValueOnce({ ok: true, json: async () => mockConnectionResponse })
			.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
		const config = createMockConfig();

		const webhook = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);
		const sendPromise = webhook.send(mockReading);

		await vi.advanceTimersByTimeAsync(30_000);
		const result = await sendPromise;

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(result).toEqual({ exitCode: 0, message: "Data sent successfully" });
	});

	it("prints the claim instructions once and keeps polling silently", async () => {
		vi.useFakeTimers();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		fetch
			.mockResolvedValueOnce({ ok: true, json: async () => mockClaimResponse })
			.mockResolvedValueOnce({ ok: true, json: async () => mockClaimResponse })
			.mockResolvedValueOnce({ ok: true, json: async () => mockConnectionResponse });
		const config = createMockConfig();

		const webhook = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);
		const connectPromise = webhook.connect();

		await vi.advanceTimersByTimeAsync(60_000);
		await connectPromise;

		const claimLogs = log.mock.calls.filter(([message]) => String(message).includes(mockClaimResponse.claimUrl));
		expect(claimLogs).toHaveLength(1);
		expect(webhook.isConnected).toBe(true);
		log.mockRestore();
	});

	it("reports unusable provisioning credentials instead of polling", async () => {
		fetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" });
		const config = createMockConfig();

		const webhook = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);

		await expect(webhook.connect()).rejects.toThrow(/Provisioning credentials rejected/);
	});

	it("re-provisions and retries once on 401", async () => {
		fetch
			.mockResolvedValueOnce({ ok: true, json: async () => mockConnectionResponse })
			.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" })
			.mockResolvedValueOnce({ ok: true, json: async () => mockConnectionResponse })
			.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
		const config = createMockConfig();

		const webhook = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);
		const result = await webhook.send(mockReading);

		expect(fetch).toHaveBeenCalledTimes(4);
		expect(result).toEqual({ exitCode: 0, message: "Data sent successfully" });
	});

	it("reuses a cached connection from config without calling /hello when still fresh", async () => {
		const config = createMockConfig({
			"energyid.webhookUrl": mockConnectionResponse.webhookUrl,
			"energyid.headers": mockConnectionResponse.headers,
			"energyid.webhookPolicy": mockConnectionResponse.webhookPolicy,
			"energyid.lastHelloAt": new Date().toISOString(),
		});
		fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

		const webhook = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);
		await webhook.send(mockReading);

		expect(fetch).toHaveBeenCalledTimes(1); // only the data send
	});

	it("re-provisions via /hello when the cached connection is older than 24h", async () => {
		const config = createMockConfig({
			"energyid.webhookUrl": mockConnectionResponse.webhookUrl,
			"energyid.headers": mockConnectionResponse.headers,
			"energyid.webhookPolicy": mockConnectionResponse.webhookPolicy,
			"energyid.lastHelloAt": new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
		});
		fetch
			.mockResolvedValueOnce({ ok: true, json: async () => mockConnectionResponse })
			.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

		const webhook = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);
		await webhook.send(mockReading);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenNthCalledWith(1, "https://hooks.energyid.eu/hello", expect.anything());
	});

	it("refreshes the connection via /hello every 24h once connected, independent of sending", async () => {
		vi.useFakeTimers();
		fetch.mockResolvedValue({ ok: true, json: async () => mockConnectionResponse });
		const config = createMockConfig();

		const webhook = new EnergyIdWebhook("TestEnergyId", { config }, mockMapping);
		await webhook.connect();
		expect(fetch).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
