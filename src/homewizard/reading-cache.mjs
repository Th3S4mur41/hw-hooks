/**
 * ReadingCache class - persists pending HomeWizard readings until they've been
 * successfully sent to EnergyID, so no data is lost across restarts or failed sends.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_CACHE_FILE = "./config/.cache.json";

export class ReadingCache {
	#filePath;
	#readings;

	/**
	 * @param {string} [filePath] - Path to the cache file (Default: ./config/.cache.json)
	 */
	constructor(filePath = DEFAULT_CACHE_FILE) {
		this.#filePath = filePath;
		this.#readings = this.#load();
	}

	/**
	 * Getter for the cached readings
	 * @returns {Array<Object>} - A copy of the currently cached readings
	 */
	get all() {
		return [...this.#readings];
	}

	/**
	 * Add a reading to the cache and persist it
	 * @param {Object} reading - The reading to cache
	 */
	add = (reading) => {
		this.#readings.push(reading);
		this.#save();
	};

	/**
	 * Remove the given readings (by identity, as returned by `all`) and persist. Readings cached while a
	 * send was in-flight are kept
	 * @param {Array<Object>} readings - The readings to drop
	 */
	remove = (readings) => {
		const sent = new Set(readings);
		this.#readings = this.#readings.filter((reading) => !sent.has(reading));
		this.#save();
	};

	/**
	 * Clear all cached readings (e.g. once they've been sent successfully) and persist
	 */
	clear = () => {
		this.#readings = [];
		this.#save();
	};

	/**
	 * Load previously cached readings from disk, defaulting to an empty list
	 * @returns {Array<Object>}
	 */
	#load = () => {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.#filePath, "utf8"));
			if (!Array.isArray(parsed)) {
				console.warn(`[ReadingCache] Ignoring invalid cache format at ${this.#filePath} (expected an array)`);
				return [];
			}
			return parsed;
		} catch (error) {
			if (error.code !== "ENOENT") {
				console.warn(`[ReadingCache] Ignoring unreadable cache at ${this.#filePath}: ${error.message}`);
			}
			return [];
		}
	};

	/**
	 * Persist the current readings to disk
	 */
	#save = () => {
		fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
		fs.writeFileSync(this.#filePath, JSON.stringify(this.#readings, null, 2));
	};
}
