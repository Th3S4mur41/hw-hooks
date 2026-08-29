#! /usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Config } from "../config/config.mjs";
import { Device } from "../homewizard/device.mjs";
import { ReadingCache } from "../homewizard/reading-cache.mjs";
import { execute, schedule, setDryRun } from "../index.mjs";
import { EnergyIdWebhook } from "../webhooks/energyid.mjs";

const CONFIG_DIR = "./config";
const MAPPING_FILE = `${CONFIG_DIR}/energyid-mapping.json`;
const DEFAULT_MAPPING = {
	total_power_import_t1_kwh: "el.t1",
	total_power_import_t2_kwh: "el.t2",
	total_power_export_t1_kwh: "el-i.t1",
	total_power_export_t2_kwh: "el-i.t2",
	total_liter_m3: "dw",
};
const MAPPING_KEY_PATTERN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/i;
const SECRETS_DIR = "/run/secrets";

/**
 * Resolve a credential from the CLI option, a Docker secret (`<name>_FILE` or /run/secrets/<name>) or the
 * environment, so secrets never have to be passed as arguments or baked into an image
 * @param {string|undefined} option - The value passed on the command line
 * @param {string} name - The credential name, e.g. "provisioning_key"
 * @returns {string|undefined} - The resolved credential
 */
const readCredential = (option, name) => {
	if (option) return option;

	const secretFile = process.env[`${name}_FILE`] || path.join(SECRETS_DIR, name);
	try {
		const secret = fs.readFileSync(secretFile, "utf8").trim();
		if (secret) return secret;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}

	return process.env[name] || undefined;
};

// Walk up from this file to find package.json: works both from src/bin (dev) and bin (build output)
const readPackageJson = () => {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const file = path.join(dir, "package.json");
		if (fs.existsSync(file)) {
			return JSON.parse(fs.readFileSync(file, "utf8"));
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return {};
		}
		dir = parent;
	}
};

const pkg = readPackageJson();

// Only well-formed meter-field -> EnergyID-property pairs are kept, so nothing else from the file can end up in a request
const readMapping = () => {
	const parsed = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8"));
	const mapping = {};

	for (const [meterField, energyIdKey] of Object.entries(parsed)) {
		if (
			typeof energyIdKey !== "string" ||
			!MAPPING_KEY_PATTERN.test(meterField) ||
			!MAPPING_KEY_PATTERN.test(energyIdKey)
		) {
			console.warn(`Ignoring invalid entry in ${MAPPING_FILE}: ${JSON.stringify(meterField)}`);
			continue;
		}
		mapping[meterField] = energyIdKey;
	}

	return mapping;
};

const yargsBin = yargs(hideBin(process.argv))
	.usage("$0 --meter <homewizard meter host or ip> [options]")
	.option("m", {
		alias: ["meter", "p", "p1"],
		description: "Hostname or IP address of the HomeWizard meter",
		type: "string",
	})
	.option("k", {
		alias: "provisioning-key",
		description:
			"EnergyID provisioning key (required on first run, stored in config/config.json afterwards). Can also be provided as a Docker secret or the provisioning_key environment variable",
		type: "string",
	})
	.option("s", {
		alias: "provisioning-secret",
		description:
			"EnergyID provisioning secret (required on first run, stored in config/config.json afterwards). Can also be provided as a Docker secret or the provisioning_secret environment variable",
		type: "string",
	})
	.option("r", {
		alias: "recurring",
		description: "Run recurring: read the meter every 5 minutes and send following EnergyID's upload interval",
		type: "boolean",
	})
	.option("o", {
		alias: "offset",
		description: "Add an offset to the meter's value (to compensate for consumption before installation)",
		type: "number",
	})
	.option("d", {
		alias: "dry-run",
		description: "Read the data and simulate sending the readings",
		type: "boolean",
	})
	.demandCommand(0)
	.help()
	.alias("h", "help")
	.version(pkg.version ?? "unknown")
	.alias("v", "version");

const argv = yargsBin.argv;

const meter = argv.meter || process.env.meter || process.env.p1; // p1 is the deprecated name of the meter variable
const provisioningKey = readCredential(argv.provisioningKey, "provisioning_key");
const provisioningSecret = readCredential(argv.provisioningSecret, "provisioning_secret");

if (!meter) {
	yargsBin.showHelp("log");
	process.exit(1);
}

console.log(`${pkg.name ?? "hw-hooks"} ${pkg.version ?? "unknown"}`);
console.log("");

setDryRun(argv.d);

// Ensure the config folder and default mapping file exist so users can inspect/customize them
fs.mkdirSync(CONFIG_DIR, { recursive: true });
try {
	// "wx" creates the file atomically, so a concurrent run can't have its mapping overwritten
	fs.writeFileSync(MAPPING_FILE, JSON.stringify(DEFAULT_MAPPING, null, 2), { flag: "wx" });
} catch (error) {
	if (error.code !== "EEXIST") throw error;
}
const mapping = readMapping();

const config = new Config(`${CONFIG_DIR}/config.json`);
const device = await Device.init(meter, argv.offset, config);

console.log("HomeWizard device:");
console.log(`  Name:     ${device.name}`);
console.log(`  Serial:   ${device.serial}`);
console.log(`  Firmware: ${device.firmwareVersion}`);
console.log(`  API:      ${device.apiVersion}`);
console.log(`  Address:  ${device.address}`);
console.log(`  Offset:   ${device.offset}`);
console.log("");

const cache = new ReadingCache(`${CONFIG_DIR}/.cache.json`);

try {
	const hook = new EnergyIdWebhook("EnergyID", { config, provisioningKey, provisioningSecret }, mapping);

	if (argv.r) {
		console.log(`Scheduling hw-hooks for ${meter}`);
		await schedule(device, hook, cache);
	} else {
		console.log(`Execute all hooks for ${meter}`);
		await execute(device, hook, cache);
	}
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
