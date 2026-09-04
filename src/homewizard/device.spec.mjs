import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../logging/logger.mjs";
import { Device } from "./device.mjs";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

globalThis.fetch = vi.fn();

describe("Device", () => {
	const mockAddress = "192.168.1.1";
	const mockOffset = 10;
	const mockData = {
		product_name: "HomeWizard",
		serial: "123456789",
		firmware_version: "1.0.0",
		api_version: "v1",
	};
	const mockApiResponse = {
		updated: "2023-01-01T00:00:00.000Z",
		data: "mockData",
	};

	beforeEach(() => {
		fetch.mockReset();
		execFile.mockReset();
	});

	it("should initialize successfully with valid data", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockData,
		});

		const device = await Device.init(mockAddress, mockOffset);

		expect(device).toBeInstanceOf(Device);
		expect(device.offset).toBe(mockOffset);
		expect(device.data).toEqual({});
		expect(device.name).toBe(mockData.product_name);
		expect(device.serial).toBe(mockData.serial);
		expect(device.firmwareVersion).toBe(mockData.firmware_version);
	});

	it("should initialize through Avahi when DNS cannot resolve an mDNS hostname", async () => {
		fetch
			.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }))
			.mockResolvedValueOnce({
				ok: true,
				json: async () => mockData,
			});
		execFile.mockImplementationOnce((_command, _args, _options, callback) => {
			callback(null, "hw-p1meter-0c380e.local\t192.168.1.123\n");
		});

		const device = await Device.init("hw-p1meter-0c380e", mockOffset);

		expect(device.address).toBe("hw-p1meter-0c380e");
		expect(execFile).toHaveBeenCalledWith(
			"avahi-resolve-host-name",
			["-4", "hw-p1meter-0c380e.local"],
			expect.any(Object),
			expect.any(Function),
		);
		expect(fetch).toHaveBeenNthCalledWith(2, "http://192.168.1.123/api/");
	});

	it("should throw an error if initialization fails", async () => {
		fetch.mockRejectedValueOnce(new Error("Network Error"));

		await expect(Device.init(mockAddress, mockOffset)).rejects.toThrow("Cannot initialize 192.168.1.1");
	});

	it("should persist name/serial/firmwareVersion to the provided config on init", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockData,
		});
		const mockConfig = { set: vi.fn() };

		await Device.init(mockAddress, mockOffset, mockConfig);

		expect(mockConfig.set).toHaveBeenCalledWith("homewizard.name", mockData.product_name);
		expect(mockConfig.set).toHaveBeenCalledWith("homewizard.serial", mockData.serial);
		expect(mockConfig.set).toHaveBeenCalledWith("homewizard.firmwareVersion", mockData.firmware_version);
	});

	it("should update data successfully", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockData,
		});

		const device = await Device.init(mockAddress, mockOffset);

		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockApiResponse,
		});

		const now = new Date();
		const data = await device.update();

		expect(data).toEqual(mockApiResponse);
		expect(device.updated - now).toBeGreaterThan(0);
		expect(device.data).toEqual(mockApiResponse);
	});

	it("should handle data update failure", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockData,
		});

		const device = await Device.init(mockAddress, mockOffset);

		fetch.mockRejectedValueOnce(new Error("Network Error"));

		await device.update();

		expect(device.data).toEqual({});
	});

	it("should log the resolved URL when update fails after Avahi resolution", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockData,
		});

		const device = await Device.init("hw-p1meter-0c380e", mockOffset);
		const error = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
		const resolvedError = new Error("Connection refused");
		fetch.mockRejectedValueOnce(error).mockRejectedValueOnce(resolvedError);
		execFile.mockImplementationOnce((_command, _args, _options, callback) => {
			callback(null, "hw-p1meter-0c380e.local\t192.168.1.123\n");
		});
		const logSpy = vi.spyOn(getLogger(), "error").mockImplementation(() => {});

		await device.update();

		expect(resolvedError.attemptedAddress).toBe("192.168.1.123");
		expect(resolvedError.attemptedUrl).toBe("http://192.168.1.123/api/v1/data/");
		expect(resolvedError.resolvedFrom).toBe("hw-p1meter-0c380e");
		expect(logSpy).toHaveBeenCalledWith(
			{ err: resolvedError },
			"hw-p1meter-0c380e cannot update data from http://192.168.1.123/api/v1/data/",
		);
		logSpy.mockRestore();
	});

	it("should return correct offset", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockData,
		});

		const device = await Device.init(mockAddress, mockOffset);

		expect(device.offset).toBe(mockOffset);
	});

	it("should return correct data", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockData,
		});

		const device = await Device.init(mockAddress, mockOffset);

		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockApiResponse,
		});

		await device.update();

		expect(device.data).toEqual(mockApiResponse);
	});
});
