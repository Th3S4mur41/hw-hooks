const DEFAULT_READ_INTERVAL = 5 * 60 * 1000; // read the meter every 5 minutes by default

let dryRun = false;

/**
 * Gets the current dry run status.
 * @returns {boolean} The current dry run status.
 */
export const getDryRun = () => dryRun;

/**
 * Sets the dry run status.
 * @param {boolean} value - The new dry run status.
 */
export const setDryRun = (value) => {
	dryRun = value;
};

/**
 * Read the device's current data and add it to the cache
 * @param {import("./homewizard/device.mjs").Device} device - The device to read from
 * @param {import("./homewizard/reading-cache.mjs").ReadingCache} cache - The cache to add the reading to
 * @returns {Promise<void>}
 */
const readAndCache = async (device, cache) => {
	const data = await device.update();
	if (data) cache.add(data);
};

/**
 * Attempt to send all cached readings to the webhook. The cache is only cleared on a successful send
 * @param {import("./webhooks/webhook.mjs").Webhook} hook - The webhook to send the cached readings to
 * @param {import("./homewizard/reading-cache.mjs").ReadingCache} cache - The cache of pending readings
 * @returns {Promise<void>}
 */
const flushCache = async (hook, cache) => {
	const readings = cache.all;
	if (readings.length === 0) return;

	const result = await hook.send(readings, dryRun);
	if (result.exitCode === 0) cache.clear();
};

/**
 * Run a single read + send cycle.
 * @param {import("./homewizard/device.mjs").Device} device - The device to read from
 * @param {import("./webhooks/webhook.mjs").Webhook} hook - The webhook to send the reading to
 * @param {import("./homewizard/reading-cache.mjs").ReadingCache} cache - The cache of pending readings
 * @returns {Promise<void>}
 */
export const execute = async (device, hook, cache) => {
	console.log("execute", device.name);
	await readAndCache(device, cache);
	await flushCache(hook, cache);
};

/**
 * Schedule recurring meter reads (every `readInterval` ms) independently from sending, which follows
 * the webhook's own upload interval (see EnergyIdWebhook#uploadInterval).
 * @param {import("./homewizard/device.mjs").Device} device - The device to read from
 * @param {import("./webhooks/energyid.mjs").EnergyIdWebhook} hook - The webhook to send cached readings to
 * @param {import("./homewizard/reading-cache.mjs").ReadingCache} cache - The cache of pending readings
 * @param {number} [readInterval] - Milliseconds between meter reads (Default: 5 minutes)
 * @returns {Promise<void>}
 */
export const schedule = async (device, hook, cache, readInterval = DEFAULT_READ_INTERVAL) => {
	console.log("schedule", device.name, `every ${readInterval}ms`);

	setInterval(() => readAndCache(device, cache), readInterval).unref?.();
	await readAndCache(device, cache);

	await hook.connect(); // learn the upload interval before scheduling sends
	const sendInterval = (hook.uploadInterval || 60) * 1000;
	console.log(`Sending cached readings every ${sendInterval}ms (EnergyID upload interval)`);
	setInterval(() => flushCache(hook, cache), sendInterval).unref?.();
	await flushCache(hook, cache);
};
