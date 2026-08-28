/**
 * Webhook class
 */

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]); // Supported HTTP methods

/**
 * Result codes returned by `Webhook.send`. Only SUCCESS means the data actually reached the remote end,
 * so callers must keep pending readings for anything else
 */
export const SEND_RESULT = {
	SUCCESS: 0,
	ERROR: 1,
	SKIPPED: 2,
};

/**
 * Whether there is nothing worth sending: no payload at all, or an object/array without entries
 * @param {*} payload - The payload returned by `_buildPayload`
 * @returns {boolean} - True when the payload carries no data
 */
const isEmptyPayload = (payload) =>
	payload === undefined || payload === null || (typeof payload === "object" && Object.keys(payload).length === 0);

export class Webhook {
	#name;
	#url;
	#method;
	#mapping;
	#callInterval;
	#synchronized = new Date(0);

	/**
	 * Create a new Webhook instance
	 * @param {*} name - Set a name for the webhook
	 * @param {*} url - Set the URL of the webhook
	 * @param {*} method - [optional] Set the method to use for the webhook (Default: GET)
	 * @param {*} mapping - [optional] Set the mapping to adapt the data to the webhook format (Default: {})
	 * @param {*} callInterval - [optional] Set the interval in seconds to call the webhook (Default: 60s)
	 */
	constructor(name, url, method = "GET", mapping = {}, callInterval = 60) {
		this.#name = name;
		this.#url = url;
		this.#method = METHODS.has(method.toUpperCase()) ? method.toUpperCase() : "GET";
		this.#mapping = mapping;
		this.#callInterval = callInterval;

		console.log(`[${this.#name}] Webhook created`);
		console.debug(
			`[${this.#name}] Webhook config: ${this.#url} - ${this.#method} - ${JSON.stringify(this.#mapping)} - Call Interval: ${this.#callInterval}ms`,
		);
	}

	/**
	 * Getter for the name property
	 * @returns {string} - The name of the webhook
	 */
	get name() {
		return this.#name;
	}

	/**
	 * Getter for the URL property
	 * @returns {string} - The URL of the webhook
	 */
	get url() {
		return this.#url;
	}

	/**
	 * Getter for the method property
	 * @returns {string} - The HTTP method of the webhook
	 */
	get method() {
		return this.#method;
	}

	/**
	 * Getter for the synchronized property
	 * @returns {Date} - The last synchronized date
	 */
	get synchronized() {
		return this.#synchronized;
	}

	/**
	 * Getter for the mapping property
	 * @returns {Object} - The mapping of the webhook
	 */
	get mapping() {
		return this.#mapping;
	}

	/**
	 * Getter for the callInterval property
	 * @returns {number} - The call interval in seconds
	 */
	get callInterval() {
		return this.#callInterval;
	}

	/**
	 * Setter for the callInterval property, so subclasses can adjust throttling once a remote policy is known
	 * @param {number} seconds - The new call interval in seconds
	 */
	set callInterval(seconds) {
		this.#callInterval = seconds;
	}

	/**
	 * Prepare the webhook before sending (e.g. provisioning). No-op by default.
	 * @returns {Promise<boolean>} - True when the webhook is ready to send
	 */
	connect = async () => true;

	/**
	 * Format the data according to the mapping
	 * @param {Object} data - The data to be formatted
	 * @returns {Object} - The formatted data
	 */
	#formatData = (data) => {
		const jsonString = JSON.stringify(this.#mapping);
		// Check if any placholders is missing from data
		const missingKeys = jsonString.match(/\$\{(\w+)\}/g).map((key) => key.substring(2, key.length - 1));
		if (missingKeys.some((key) => data[key] === undefined)) {
			console.debug(`[${this.#name}] Missing keys in data: ${missingKeys}`);
			return undefined;
		}

		// Replace the placeholders with the data
		const formattedData = jsonString.replace(/\$\{(\w+)\}/g, (_, key) => data[key]);
		return JSON.parse(formattedData);
	};

	/**
	 * Build the request payload for the given data. Override in subclasses to customize the payload shape.
	 * @param {Object} data - The data to be formatted
	 * @returns {Object|undefined} - The payload to send, or undefined to skip sending
	 */
	_buildPayload(data) {
		return this.#formatData(data);
	}

	/**
	 * Resolve the URL to send the request to. Override in subclasses for dynamic URLs.
	 * @returns {Promise<string>|string} - The URL to send the request to
	 */
	_getUrl() {
		return this.#url;
	}

	/**
	 * Resolve the headers to send with the request. Override in subclasses to add/replace headers.
	 * @returns {Promise<Object>|Object} - The headers to send with the request
	 */
	_getHeaders() {
		return {
			Accept: "application/json",
			"Content-Type": "application/json",
		};
	}

	/**
	 * Called when the server responds with 401 Unauthorized, before a single retry. No-op by default.
	 */
	async _onUnauthorized() {}

	/**
	 * Send the data to the webhook URL
	 * @param {Object} data - The data to be sent
	 * @param {boolean} dryRun - If true, log the data instead of sending it
	 * @returns {Promise<{exitCode: number, message: string}>} - SEND_RESULT.SUCCESS only when the data was sent
	 */
	send = async (data = "", dryRun = false) => {
		const jsonData = await this._buildPayload(data);

		if (isEmptyPayload(jsonData)) {
			console.warn(`[${this.#name}] No data matching the mapping. Skipping send.`);
			return { exitCode: SEND_RESULT.ERROR, message: "No data matching the mapping. Skipping send." };
		}

		// Check if the last send was within the last hour
		const now = new Date();
		if (now - this.#synchronized < this.#callInterval * 1000) {
			console.log(`[${this.#name}] Data was sent less than ${this.#callInterval}s ago. Skipping send.`);
			return {
				exitCode: SEND_RESULT.SKIPPED,
				message: `Data was sent less than ${this.#callInterval}s ago. Skipping send.`,
			};
		}

		if (dryRun) {
			console.log(`[${this.#name}] Would send ${JSON.stringify(jsonData)}...`);
			return { exitCode: SEND_RESULT.SKIPPED, message: "Dry run. Nothing was sent." };
		}
		console.log(`[${this.#name}] Sending ${JSON.stringify(jsonData)}...`);

		try {
			let response = await this.#request(jsonData);
			if (response.status === 401) {
				await this._onUnauthorized();
				response = await this.#request(jsonData);
			}

			// Applied to the 401 retry response too, so a rate limit hit there is reported the same way
			const rateLimited = this.#handleRateLimit(response);
			if (rateLimited) return rateLimited;

			if (!response.ok) {
				throw new Error(`Failed to send data: ${response.statusText}`);
			}
			console.log(`[${this.#name}] Data sent successfully`);
		} catch (error) {
			console.error("Failed to send data", error);
			return { exitCode: SEND_RESULT.ERROR, message: error.message };
		}

		this.#synchronized = now;
		return { exitCode: SEND_RESULT.SUCCESS, message: "Data sent successfully" };
	};

	/**
	 * Report a 429 response as a structured result, defaulting Retry-After when the header is missing
	 * @param {Response} response - The response to check
	 * @returns {{exitCode: number, message: string}|undefined} - The result when rate limited, otherwise undefined
	 */
	#handleRateLimit = (response) => {
		if (response.status !== 429) return undefined;

		const retryAfter = response.headers.get("Retry-After") ?? "unknown";
		console.warn(`[${this.#name}] Rate limited. Retry after ${retryAfter}s`);
		return { exitCode: SEND_RESULT.ERROR, message: `Rate limited. Retry after ${retryAfter}s` };
	};

	/**
	 * Issue the actual HTTP request, resolving URL/headers on each attempt to support dynamic values
	 * @param {Object} jsonData - The payload to send
	 */
	#request = async (jsonData) => {
		const url = await this._getUrl();
		const headers = await this._getHeaders();
		return fetch(
			url,
			(() => {
				const init = {
					method: this.#method,
					headers,
				};
				if (this.#method !== "GET" && this.#method !== "HEAD") {
					init.body = JSON.stringify(jsonData);
				}
				return init;
			})(),
		);
	};
}
