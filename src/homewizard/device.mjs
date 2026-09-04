/**
 * Device class - reads data from a HomeWizard device. Sending that data onward (e.g. to EnergyID)
 * is handled independently by the caller (see src/index.mjs), so Device only deals with reading.
 */

import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { getLogger } from "../logging/logger.mjs";

const PROTOCOL = "http"; // Protocol used for API requests
const PRIVATE_CONSTRUCTOR_KEY = Symbol("private"); // Symbol to enforce private constructor
const AVAHI_TIMEOUT_MS = 5000;

const isDnsNotFound = (error) => error?.cause?.code === "ENOTFOUND" || error?.code === "ENOTFOUND";

const resolveWithAvahi = async (address) => {
	if (isIP(address)) return address;

	const candidates = [...new Set([address.endsWith(".local") ? address : `${address}.local`, address])];
	for (const candidate of candidates) {
		try {
			const stdout = await new Promise((resolve, reject) => {
				execFile("avahi-resolve-host-name", ["-4", candidate], { timeout: AVAHI_TIMEOUT_MS }, (error, output) => {
					if (error) reject(error);
					else resolve(output);
				});
			});
			const [, resolvedAddress] = stdout.trim().split(/\s+/);
			if (resolvedAddress) return resolvedAddress;
		} catch {
			// Try the next candidate; the original fetch error is more useful to callers if none resolve.
		}
	}

	return address;
};

const fetchFromDevice = async (address, apiPath) => {
	const url = `${PROTOCOL}://${address}${apiPath}`;
	try {
		return { address, response: await fetch(url), url };
	} catch (error) {
		if (!isDnsNotFound(error)) throw error;

		const resolvedAddress = await resolveWithAvahi(address);
		if (resolvedAddress === address) throw error;

		const resolvedUrl = `${PROTOCOL}://${resolvedAddress}${apiPath}`;
		getLogger().debug(`${address} resolved to ${resolvedAddress} via Avahi`);
		return { address: resolvedAddress, response: await fetch(resolvedUrl), url: resolvedUrl };
	}
};

export class Device {
	#name;
	#serial;
	#firmwareVersion;
	#apiVersion;
	#address;
	#apiAddress;
	#offset;
	#data = {};
	#updated = new Date(0);

	/**
	 * Private constructor to enforce the use of the init method
	 * @param {string} key - Private key to enforce private constructor
	 * @param {string} name - Name of the device
	 * @param {string} serial - Serial number of the device
	 * @param {string} firmwareVersion - Firmware version of the device
	 * @param {string} apiVersion - API version of the device
	 * @param {string} address - Address of the device
	 * @param {number} offset - Offset value for the device
	 */
	constructor(key, name, serial, firmwareVersion, apiVersion, address, apiAddress, offset) {
		if (key !== PRIVATE_CONSTRUCTOR_KEY) {
			throw new Error("Use Device.init() to create an instance");
		}
		this.#name = name;
		this.#serial = serial;
		this.#firmwareVersion = firmwareVersion;
		this.#apiVersion = apiVersion;
		this.#address = address;
		this.#apiAddress = apiAddress;
		this.#offset = offset;
	}

	/**
	 * Initialize a new Device instance. When a Config is provided, the device's identity
	 * (name/serial/firmwareVersion) is persisted so it can be reused elsewhere (e.g. by the EnergyID webhook)
	 * @param {string} address - Address of the device
	 * @param {number} offset - [optional] Offset value for the device (Default: 0)
	 * @param {import("../config/config.mjs").Config} [config] - Config instance to persist device metadata to
	 * @returns {Promise<Device>} - A promise that resolves to a new Device instance
	 */
	static async init(address, offset = 0, config = undefined) {
		try {
			const { response, address: apiAddress } = await fetchFromDevice(address, "/api/");
			if (!response.ok) {
				throw new Error(`Cannot initialize ${address}`);
			}
			const data = await response.json();

			config?.set("homewizard.name", data.product_name);
			config?.set("homewizard.serial", data.serial);
			config?.set("homewizard.firmwareVersion", data.firmware_version);

			return new Device(
				PRIVATE_CONSTRUCTOR_KEY,
				data.product_name,
				data.serial,
				data.firmware_version,
				data.api_version,
				address,
				apiAddress,
				offset,
			);
		} catch (error) {
			throw new Error(`Cannot initialize ${address}`, { cause: error });
		}
	}

	/**
	 * Getter for the name property
	 * @returns {string} - The product name of the device
	 */
	get name() {
		return this.#name;
	}

	/**
	 * Getter for the serial property
	 * @returns {string} - The serial number of the device
	 */
	get serial() {
		return this.#serial;
	}

	/**
	 * Getter for the firmwareVersion property
	 * @returns {string} - The firmware version of the device
	 */
	get firmwareVersion() {
		return this.#firmwareVersion;
	}

	/**
	 * Getter for the apiVersion property
	 * @returns {string} - The API version of the device
	 */
	get apiVersion() {
		return this.#apiVersion;
	}

	/**
	 * Getter for the address property
	 * @returns {string} - The hostname or IP address of the device
	 */
	get address() {
		return this.#address;
	}

	/**
	 * Getter for the data property
	 * @returns {Object} - The data of the device
	 */
	get data() {
		return this.#data;
	}

	/**
	 * Getter for the offset property
	 * @returns {number} - The offset value of the device
	 */
	get offset() {
		return this.#offset;
	}

	/**
	 * Setter for the offset property
	 * @param {number} newOffset - The new offset value
	 */
	set offset(newOffset) {
		if (typeof newOffset !== "number") {
			throw new TypeError("Offset must be a number");
		}
		this.#offset = newOffset;
	}

	/**
	 * Getter for the updated property
	 * @returns {Date} - The last updated date of the device's data
	 */
	get updated() {
		return this.#updated;
	}

	/**
	 * Update the data from the HomeWizard device
	 * @returns {Promise<Object>} - The data from the HomeWizard device
	 */
	update = async () => {
		const apiPath = `/api/${this.#apiVersion}/data/`;
		const url = `${PROTOCOL}://${this.#apiAddress}${apiPath}`;
		getLogger().info(`[${this.#name} - ${this.#serial}] Updating data from ${url} ...`);

		return fetchFromDevice(this.#apiAddress, apiPath)
			.then((result) => {
				this.#apiAddress = result.address;
				getLogger().debug(`${this.#address}'s data:`);
				return result.response.json();
			})
			.then((data) => {
				if (!data.updated) {
					// If data does not contain an "updated" field, set the current timestamp
					const updated = new Date();
					updated.setSeconds(0, 0); // Keep an offset of 0 seconds to avoid time offset issues with the webhook server
					data.updated = updated.toISOString();
				}

				getLogger().debug(data, `[${this.#name} - ${this.#serial}] Received data`);
				this.#data = data;
				this.#updated = new Date();
				return data;
			})
			.catch((error) => {
				getLogger().error({ err: error }, `${this.#address} cannot update data from ${url}`);
			});
	};
}
