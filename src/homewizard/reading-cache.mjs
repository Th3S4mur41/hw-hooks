/**
 * ReadingCache class - persists pending HomeWizard readings until they've been
 * successfully sent to EnergyID, so no data is lost across restarts or failed sends.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_CACHE_FILE = "./config/.cache.json";
const READING_KEY_PATTERN = /^[a-z0-9_.-]+$/i;

/**
 * Rebuild a cached entry from validated primitives only: an ISO `updated` timestamp and finite numeric
 * meter values. Anything else in the file is dropped, so a corrupted or tampered cache can't be forwarded
 * @param {*} entry - A raw entry read from the cache file
 * @returns {Object|undefined} - The sanitized reading, or undefined when the entry is unusable
 */
const sanitizeReading = (entry) => {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;

	const updated = typeof entry.updated === "string" ? Date.parse(entry.updated) : Number.NaN;
	if (!Number.isFinite(updated)) return undefined;

	const reading = { updated: new Date(updated).toISOString() };
	for (const [key, value] of Object.entries(entry)) {
		if (key !== "updated" && READING_KEY_PATTERN.test(key) && typeof value === "number" && Number.isFinite(value)) {
			reading[key] = value;
		}
	}

	return reading;
};

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
	 * Add a reading to the cache and persist it. The reading is sanitized first, so only a timestamp and
	 * finite numeric meter values are ever written to disk
	 * @param {Object} reading - The reading to cache
	 * @returns {boolean} - False when the reading was rejected as invalid
	 */
	add = (reading) => {
		const sanitized = sanitizeReading(reading);
		if (!sanitized) {
			console.warn("[ReadingCache] Ignoring invalid reading");
			return false;
		}

		this.#readings.push(sanitized);
		this.#save();
		return true;
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
	 * Load previously cached readings from disk, dropping anything that doesn't pass validation
	 * @returns {Array<Object>}
	 */
	#load = () => {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.#filePath, "utf8"));
			if (!Array.isArray(parsed)) {
				console.warn(`[ReadingCache] Ignoring invalid cache format at ${this.#filePath} (expected an array)`);
				return [];
			}

			const readings = parsed.map(sanitizeReading).filter((reading) => reading !== undefined);
			if (readings.length !== parsed.length) {
				console.warn(
					`[ReadingCache] Dropped ${parsed.length - readings.length} invalid reading(s) from ${this.#filePath}`,
				);
			}
			return readings;
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
