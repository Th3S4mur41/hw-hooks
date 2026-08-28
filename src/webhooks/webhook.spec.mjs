// src/webhook.test.mjs
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "./webhook.mjs";

globalThis.fetch = vi.fn();

describe("Webhook", () => {
	const mockName = "TestWebhook";
	const mockUrl = "https://example.com/webhook";
	const mockMethod = "POST";
	const mockMapping = {
		key1: "${value1}",
		key2: "${value2}",
	};
	const mockData = {
		value1: "data1",
		value2: "data2",
	};

	beforeEach(() => {
		fetch.mockReset();
	});

	it("should initialize successfully with valid data", () => {
		const webhook = new Webhook(mockName, mockUrl, mockMethod, mockMapping);

		expect(webhook).toBeInstanceOf(Webhook);
		expect(webhook.name).toBe(mockName);
		expect(webhook.url).toBe(mockUrl);
		expect(webhook.method).toBe(mockMethod);
	});

	it("should default to GET method if invalid method is provided", () => {
		const invalidMethod = "INVALID";
		const webhook = new Webhook(mockName, mockUrl, invalidMethod, mockMapping);

		expect(webhook.method).toBe("GET");
	});

	it("should send data successfully", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ success: true }),
		});

		const webhook = new Webhook(mockName, mockUrl, mockMethod, mockMapping);

		const result = await webhook.send(mockData);

		expect(fetch).toHaveBeenCalledWith(mockUrl, {
			method: mockMethod,
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				key1: "data1",
				key2: "data2",
			}),
		});
		expect(result).toEqual({ exitCode: 0, message: "Data sent successfully" });
	});

	it("should not send an empty payload", async () => {
		const webhook = new Webhook(mockName, mockUrl, mockMethod, mockMapping);
		vi.spyOn(webhook, "_buildPayload").mockReturnValue({});

		const result = await webhook.send(mockData);

		expect(fetch).not.toHaveBeenCalled();
		expect(result).toEqual({ exitCode: 1, message: "No data matching the mapping. Skipping send." });
	});

	it("should handle data sending failure", async () => {
		fetch.mockResolvedValueOnce({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
		});

		const webhook = new Webhook(mockName, mockUrl, mockMethod, mockMapping);

		const result = await webhook.send(mockData);

		expect(fetch).toHaveBeenCalledWith(mockUrl, {
			method: mockMethod,
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				key1: "data1",
				key2: "data2",
			}),
		});
		expect(result).toEqual({ exitCode: 1, message: "Failed to send data: Internal Server Error" });
	});

	it("should log data instead of sending when dryRun is true", async () => {
		const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const webhook = new Webhook(mockName, mockUrl, mockMethod, mockMapping);

		const result = await webhook.send(mockData, true);

		expect(consoleLogSpy).toHaveBeenCalledWith(
			`[${mockName}] Would send ${JSON.stringify({
				key1: "data1",
				key2: "data2",
			})}...`,
		);
		expect(result).toEqual({ exitCode: 2, message: "Dry run. Nothing was sent." });

		consoleLogSpy.mockRestore();
	});

	it("should not send data if called within the call interval", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ success: true }),
		});
		const webhook = new Webhook(mockName, mockUrl, mockMethod, mockMapping);

		await webhook.send(mockData);

		// Second call within the interval
		const result = await webhook.send(mockData);

		expect(result).toEqual({ exitCode: 2, message: "Data was sent less than 60s ago. Skipping send." });
		expect(fetch).toHaveBeenCalledTimes(1); // Ensure fetch was called only once
	});

	it("should send data if called after the call interval", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ success: true }),
		});
		const webhook = new Webhook(mockName, mockUrl, mockMethod, mockMapping, 1); // 1 second interval

		// First call to send data
		await webhook.send(mockData);

		// Wait for the interval to pass
		await new Promise((resolve) => setTimeout(resolve, 1100));

		// Second call after the interval
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ success: true }),
		});
		const result = await webhook.send(mockData);

		expect(fetch).toHaveBeenCalledTimes(2); // Ensure fetch was called twice
		expect(result).toEqual({ exitCode: 0, message: "Data sent successfully" });
	});
});
