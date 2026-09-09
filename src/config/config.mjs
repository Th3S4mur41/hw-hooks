/**
 * Config class - handles loading, persisting and accessing app configuration stored as JSON.
 * The config folder/file is created automatically if it doesn't exist yet.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "../logging/logger.mjs";

const DEFAULT_CONFIG_FILE = "./config/config.json";

export class Config {
	#filePath;
	#data;

	/**
	 * @param {string} [filePath] - Path to the JSON config file (Default: ./config/config.json)
	 */
	constructor(filePath = DEFAULT_CONFIG_FILE) {
		this.#filePath = filePath;
		this.#data = this.#load();
	}

	/**
	 * Load the config file, creating the folder/file with an empty object if it doesn't exist yet
	 * @returns {Object} - The parsed config
	 */
	#load = () => {
		let text;
		try {
			text = fs.readFileSync(this.#filePath, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			getLogger().debug(`[Config] No config file found. Creating a new one at ${this.#filePath}`);
			this.#data = {};
			this.#save();
			return this.#data;
		}
		return JSON.parse(text);
	};

	/**
	 * Persist the in-memory config to disk
	 */
	#save = () => {
		fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
		fs.writeFileSync(this.#filePath, JSON.stringify(this.#data, null, 2));
	};

	/**
	 * Get a (possibly nested, dot-separated) config value
	 * @param {string} key - e.g. "energyid.provisioningKey"
	 * @param {*} [defaultValue] - Returned when the key isn't set
	 * @returns {*} - The stored value, or `defaultValue`
	 */
	get = (key, defaultValue) => {
		const value = key.split(".").reduce((obj, part) => obj?.[part], this.#data);
		return value === undefined ? defaultValue : value;
	};

	/**
	 * Set a (possibly nested, dot-separated) config value and persist immediately
	 * @param {string} key - e.g. "energyid.provisioningKey"
	 * @param {*} value - The value to store
	 */
	set = (key, value) => {
		const parts = key.split(".");
		const lastKey = parts.pop();
		const target = parts.reduce((obj, part) => {
			if (typeof obj[part] !== "object" || obj[part] === null) obj[part] = {};
			return obj[part];
		}, this.#data);
		target[lastKey] = value;
		this.#save();
	};
}
