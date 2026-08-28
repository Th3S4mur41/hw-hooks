/**
 * EnergyID incoming webhook (provisioning-based), see https://help.energyid.eu/en/developer/incoming-webhooks/
 */

import { randomUUID } from "node:crypto";
import { Webhook } from "./webhook.mjs";

const HELLO_URL = "https://hooks.energyid.eu/hello";
const CLAIM_POLL_INTERVAL = 30_000; // 30s, per EnergyID docs
const HELLO_REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // refresh the connection every 24h, independent of sending, per EnergyID docs
const ENERGYID_KEY_PATTERN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/i; // predefined properties, optionally prefixed, e.g. "el-i.t1"
const WEBHOOK_HOST = "hooks.energyid.eu";

/**
 * Whether a webhook URL is an https EnergyID endpoint, so a tampered config can't redirect readings elsewhere
 * @param {string} url - The webhook URL to check
 * @returns {boolean} - True when the URL is safe to post to
 */
const isEnergyIdWebhookUrl = (url) => {
	try {
		const { protocol, hostname } = new URL(url);
		return protocol === "https:" && hostname === WEBHOOK_HOST;
	} catch {
		return false;
	}
};

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
	#provisioning;
	#claimCodeShown;

	/**
	 * Create a new EnergyIdWebhook instance. Device identity defaults to the HomeWizard device info
	 * previously persisted to `config` (see Device.init); provisioning credentials must be provided once and
	 * are then reused from `config`. Everything is persisted (under the "energyid" namespace) to `config`.
	 * @param {string} name - Set a name for the webhook
	 * @param {Object} options - Provisioning options
	 * @param {import("../config/config.mjs").Config} options.config - Config instance used to read/persist state
	 * @param {string} [options.deviceId] - Unique device id (defaults to config's homewizard.serial)
	 * @param {string} [options.deviceName] - Human-readable device name (defaults to config's homewizard.name)
	 * @param {string} [options.firmwareVersion] - Device firmware version (defaults to config's homewizard.firmwareVersion)
	 * @param {string} [options.provisioningKey] - The EnergyID provisioning key (required unless already stored in config)
	 * @param {string} [options.provisioningSecret] - The EnergyID provisioning secret (required unless already stored in config)
	 * @param {Object} mapping - [optional] Map of data key to EnergyID (predefined) property key (Default: {})
	 * @param {number} callInterval - [optional] Set the interval in seconds to call the webhook (Default: 60s)
	 */
	constructor(
		name,
		{ config, deviceId, deviceName, firmwareVersion, provisioningKey, provisioningSecret },
		mapping = {},
		callInterval = 60,
	) {
		// Resolved before super() so an incomplete setup fails before the webhook announces itself
		const key = provisioningKey || config.get("energyid.provisioningKey");
		const secret = provisioningSecret || config.get("energyid.provisioningSecret");
		if (!key || !secret) {
			throw new Error(
				[
					"Missing EnergyID provisioning credentials.",
					"  1. Open https://app.energyid.eu/integrations/webhook-in",
					'  2. Click the "+" button in the top right corner of the "Provisioning credentials" box',
					"  3. Start hw-hooks with --provisioning-key=<key> --provisioning-secret=<secret>",
					"They are stored in the config afterwards, so this is only needed once.",
				].join("\n"),
			);
		}

		super(name, null, "POST", mapping, callInterval);
		this.#config = config;

		this.#deviceId = deviceId || config.get("homewizard.serial") || randomUUID();
		this.#deviceName = deviceName || config.get("homewizard.name") || this.#deviceId;
		this.#firmwareVersion = firmwareVersion || config.get("homewizard.firmwareVersion");
		this.#provisioningKey = key;
		this.#provisioningSecret = secret;
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
	 * Whether a WebhookConnectionInfo is available, i.e. data may be sent
	 * @returns {boolean} - True when the device is claimed and a webhook URL is known
	 */
	get isConnected() {
		return Boolean(this.#webhookUrl);
	}

	/**
	 * Ensure the device is provisioned via /hello and start the independent 24h refresh timer.
	 * Resolves only once a WebhookConnectionInfo was received, polling /hello while the device is unclaimed
	 * @returns {Promise<boolean>} - True once connected
	 */
	connect = async () => {
		this.#startHelloRefreshTimer();
		return this.#ensureProvisioned();
	};

	/**
	 * Start a timer that refreshes the connection via /hello every 24h, independent of sending data
	 */
	#startHelloRefreshTimer = () => {
		if (this.#helloTimer) return;
		this.#helloTimer = setInterval(() => {
			void this.#ensureProvisioned().catch((error) =>
				console.error(`[${this.name}] Failed to refresh EnergyID connection: ${error.message}`),
			);
		}, HELLO_REFRESH_INTERVAL);
		this.#helloTimer.unref?.();
	};

	/**
	 * Apply a webhook connection response (or cached config) to this instance's state
	 * @param {Object} connection - The webhook connection info (webhookUrl, headers, webhookPolicy, recordName, recordNumber)
	 */
	#applyConnection = (connection) => {
		if (!connection?.webhookUrl) return;

		if (!isEnergyIdWebhookUrl(connection.webhookUrl)) {
			console.warn(`[${this.name}] Ignoring webhook URL outside https://${WEBHOOK_HOST}: ${connection.webhookUrl}`);
			return;
		}

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
	 * Print the claim instructions for the user. Only printed once per claim code, so polling stays silent
	 * @param {Object} claim - The WebhookClaimInfo returned by /hello (claimCode, claimUrl, exp)
	 */
	#showClaimInstructions = ({ claimCode, claimUrl, exp }) => {
		if (this.#claimCodeShown === claimCode) return;
		this.#claimCodeShown = claimCode;

		console.log("");
		console.log(`[${this.name}] This device is not linked to an EnergyID record yet.`);
		console.log(`  Claim code: ${claimCode}`);
		console.log(`  Claim URL:  ${claimUrl}`);
		if (exp) console.log(`  Expires:    ${new Date(exp * 1000).toLocaleString()}`);
		console.log("  Open the claim URL and follow the instructions on the EnergyID website to link this device.");
		console.log("  Waiting for the device to be claimed...");
		console.log("");
	};

	/**
	 * Call the /hello endpoint once
	 * @returns {Promise<boolean>} - True when a WebhookConnectionInfo was received, false when still unclaimed
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

		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`Provisioning credentials rejected by EnergyID (${response.status}). Activate the "Incoming webhook" integration on your EnergyID record to obtain a provisioning key and secret, then pass them with --provisioning-key and --provisioning-secret.`,
			);
		}

		if (!response.ok) {
			throw new Error(`Failed to provision device: ${response.status} ${response.statusText}`);
		}

		const body = await response.json();

		if (!body.webhookUrl) {
			this.#showClaimInstructions(body);
			return false;
		}

		this.#applyConnection(body);
		this.#lastHelloAt = new Date();
		this.#persistConnection();
		this.#claimCodeShown = undefined;
		console.log(`[${this.name}] Device claimed for record ${body.recordName} (${body.recordNumber})`);
		return true;
	};

	/**
	 * Ensure a WebhookConnectionInfo is available, (re-)calling /hello when there's no connection yet or it's
	 * stale (> 24h), and polling every 30s while the device is unclaimed
	 * @returns {Promise<boolean>} - True once connected
	 */
	#ensureProvisioned = async () => {
		const isStale = Date.now() - this.#lastHelloAt.getTime() >= HELLO_REFRESH_INTERVAL;
		if (this.#webhookUrl && !isStale) return true;

		// Share a single in-flight provisioning run, so concurrent senders don't poll /hello in parallel
		this.#provisioning ??= (async () => {
			while (!(await this.#hello())) {
				await sleep(CLAIM_POLL_INTERVAL);
			}
			return true;
		})().finally(() => {
			this.#provisioning = undefined;
		});

		return this.#provisioning;
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
		return { ...(this.#headers ?? {}), "Content-Type": "application/json" };
	};

	/**
	 * Map a single reading to an EnergyID payload ({ts, ...}) using the configured mapping.
	 * Only finite numeric meter values are forwarded, so nothing else can leak into the request body
	 * @param {Object} reading - A single HomeWizard reading
	 * @returns {Object|undefined} - The mapped payload, or undefined if no mapped keys are present
	 */
	#mapReading = (reading) => {
		const payload = {};
		for (const [dataKey, energyIdKey] of Object.entries(this.mapping)) {
			const value = reading[dataKey];
			if (typeof value === "number" && Number.isFinite(value) && ENERGYID_KEY_PATTERN.test(energyIdKey)) {
				payload[energyIdKey] = value;
			}
		}

		if (Object.keys(payload).length === 0) return undefined;

		const timestamp = Math.floor(Date.parse(reading.updated) / 1000);
		if (!Number.isFinite(timestamp)) return undefined;

		payload.ts = timestamp;
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
