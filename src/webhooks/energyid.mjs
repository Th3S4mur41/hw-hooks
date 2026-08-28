/**
 * EnergyID incoming webhook (provisioning-based), see https://help.energyid.eu/en/developer/incoming-webhooks/
 */

import { randomUUID } from "node:crypto";
import { Webhook } from "./webhook.mjs";

const HELLO_URL = "https://hooks.energyid.eu/hello";
const CLAIM_POLL_INTERVAL = 30_000; // 30s, per EnergyID docs
const HELLO_REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // refresh the connection every 24h, independent of sending, per EnergyID docs

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class EnergyIdWebhook extends Webhook {
	#config;
	#deviceId;
	#deviceName;
	#firmwareVersion;
	#provisioningKey;
	#provisioningSecret;
	#webhookUrl;
	#headers;
	#policy;
	#recordName;
	#recordNumber;
	#lastHelloAt;
	#helloTimer;

	/**
	 * Create a new EnergyIdWebhook instance. Device identity defaults to the HomeWizard device info
	 * previously persisted to `config` (see Device.init); provisioning credentials are generated when
	 * not provided. Everything is persisted (under the "energyid" namespace) to `config`.
	 * @param {string} name - Set a name for the webhook
	 * @param {Object} options - Provisioning options
	 * @param {import("../config/config.mjs").Config} options.config - Config instance used to read/persist state
	 * @param {string} [options.deviceId] - Unique device id (defaults to config's homewizard.serial)
	 * @param {string} [options.deviceName] - Human-readable device name (defaults to config's homewizard.name)
	 * @param {string} [options.firmwareVersion] - Device firmware version (defaults to config's homewizard.firmwareVersion)
	 * @param {string} [options.provisioningKey] - The EnergyID provisioning key (generated if omitted)
	 * @param {string} [options.provisioningSecret] - The EnergyID provisioning secret (generated if omitted)
	 * @param {Object} mapping - [optional] Map of data key to EnergyID (predefined) property key (Default: {})
	 * @param {number} callInterval - [optional] Set the interval in seconds to call the webhook (Default: 60s)
	 */
	constructor(
		name,
		{ config, deviceId, deviceName, firmwareVersion, provisioningKey, provisioningSecret },
		mapping = {},
		callInterval = 60,
	) {
		super(name, null, "POST", mapping, callInterval);
		this.#config = config;

		this.#deviceId = deviceId || config.get("homewizard.serial") || randomUUID();
		this.#deviceName = deviceName || config.get("homewizard.name") || this.#deviceId;
		this.#firmwareVersion = firmwareVersion || config.get("homewizard.firmwareVersion");
		this.#provisioningKey = provisioningKey || config.get("energyid.provisioningKey") || randomUUID();
		this.#provisioningSecret = provisioningSecret || config.get("energyid.provisioningSecret") || randomUUID();
		this.#lastHelloAt = new Date(config.get("energyid.lastHelloAt", 0));
		this.#applyConnection({
			webhookUrl: config.get("energyid.webhookUrl"),
			headers: config.get("energyid.headers"),
			webhookPolicy: config.get("energyid.webhookPolicy"),
			recordName: config.get("energyid.recordName"),
			recordNumber: config.get("energyid.recordNumber"),
		});

		this.#config.set("energyid.provisioningKey", this.#provisioningKey);
		this.#config.set("energyid.provisioningSecret", this.#provisioningSecret);
	}

	/**
	 * Getter for the EnergyID upload interval (seconds), once known from a provisioning response
	 * @returns {number|undefined} - The upload interval in seconds
	 */
	get uploadInterval() {
		return this.#policy?.uploadInterval;
	}

	/**
	 * Ensure the device is provisioned and start the independent 24h refresh timer.
	 * Safe to call ahead of time (e.g. to read `uploadInterval`)
	 * @returns {Promise<void>}
	 */
	connect = async () => {
		this.#startHelloRefreshTimer();
		await this.#ensureProvisioned();
	};

	/**
	 * Start a timer that refreshes the connection via /hello every 24h, independent of sending data
	 */
	#startHelloRefreshTimer = () => {
		if (this.#helloTimer) return;
		this.#helloTimer = setInterval(() => this.#ensureProvisioned(), HELLO_REFRESH_INTERVAL);
		this.#helloTimer.unref?.();
	};

	/**
	 * Apply a webhook connection response (or cached config) to this instance's state
	 * @param {Object} connection - The webhook connection info (webhookUrl, headers, webhookPolicy, recordName, recordNumber)
	 */
	#applyConnection = (connection) => {
		if (!connection?.webhookUrl) return;

		this.#webhookUrl = connection.webhookUrl;
		this.#headers = connection.headers;
		this.#policy = connection.webhookPolicy;
		this.#recordName = connection.recordName;
		this.#recordNumber = connection.recordNumber;

		if (this.#policy?.uploadInterval) {
			this.callInterval = this.#policy.uploadInterval;
		}
	};

	/**
	 * Persist the current connection info to config, so sending can reuse it without calling /hello again
	 */
	#persistConnection = () => {
		this.#config.set("energyid.webhookUrl", this.#webhookUrl);
		this.#config.set("energyid.headers", this.#headers);
		this.#config.set("energyid.webhookPolicy", this.#policy);
		this.#config.set("energyid.recordName", this.#recordName);
		this.#config.set("energyid.recordNumber", this.#recordNumber);
		this.#config.set("energyid.lastHelloAt", this.#lastHelloAt.toISOString());
	};

	/**
	 * Call the /hello endpoint to provision the device, polling every 30s until claimed
	 * @returns {Promise<void>}
	 */
	#hello = async () => {
		const response = await fetch(HELLO_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Provisioning-Key": this.#provisioningKey,
				"X-Provisioning-Secret": this.#provisioningSecret,
			},
			body: JSON.stringify({
				deviceId: this.#deviceId,
				deviceName: this.#deviceName,
				firmwareVersion: this.#firmwareVersion,
			}),
		});

		if (!response.ok) {
			throw new Error(`Failed to provision device: ${response.statusText}`);
		}

		const body = await response.json();

		if (body.webhookUrl) {
			this.#applyConnection(body);
			this.#lastHelloAt = new Date();
			this.#persistConnection();
			console.log(`[${this.name}] Device claimed for record ${body.recordName} (${body.recordNumber})`);
			return;
		}

		console.log(`[${this.name}] Device not yet claimed. Open ${body.claimUrl} (code: ${body.claimCode}) to link it.`);
		await sleep(CLAIM_POLL_INTERVAL);
		await this.#hello();
	};

	/**
	 * Ensure the device is provisioned, (re-)calling /hello if there's no connection yet or it's stale (> 24h)
	 * @returns {Promise<void>}
	 */
	#ensureProvisioned = async () => {
		const isStale = Date.now() - this.#lastHelloAt.getTime() >= HELLO_REFRESH_INTERVAL;
		if (!this.#webhookUrl || isStale) {
			await this.#hello();
		}
	};

	/**
	 * @override
	 */
	_getUrl = async () => {
		await this.#ensureProvisioned();
		return this.#webhookUrl;
	};

	/**
	 * @override
	 */
	_getHeaders = async () => {
		await this.#ensureProvisioned();
		return { ...this.#headers, "Content-Type": "application/json" };
	};

	/**
	 * Map a single reading to an EnergyID payload ({ts, ...}) using the configured mapping
	 * @param {Object} reading - A single HomeWizard reading
	 * @returns {Object|undefined} - The mapped payload, or undefined if no mapped keys are present
	 */
	#mapReading = (reading) => {
		const payload = {};
		for (const [dataKey, energyIdKey] of Object.entries(this.mapping)) {
			if (reading[dataKey] !== undefined) {
				payload[energyIdKey] = reading[dataKey];
			}
		}

		if (Object.keys(payload).length === 0) return undefined;

		payload.ts = Math.floor(Date.parse(reading.updated) / 1000);
		return payload;
	};

	/**
	 * @override
	 * Accepts either a single reading or an array of cached readings (sent as an EnergyID batch upload)
	 */
	_buildPayload(data) {
		const readings = Array.isArray(data) ? data : [data];
		const payloads = readings.map(this.#mapReading).filter((payload) => payload !== undefined);

		if (payloads.length === 0) {
			console.debug(`[${this.name}] No data matching the mapping: ${Object.keys(this.mapping)}`);
			return undefined;
		}

		return Array.isArray(data) ? payloads : payloads[0];
	}

	/**
	 * @override
	 */
	_onUnauthorized = async () => {
		console.log(`[${this.name}] Authorization expired. Re-provisioning...`);
		this.#webhookUrl = undefined;
		this.#headers = undefined;
		await this.#ensureProvisioned();
	};
}
