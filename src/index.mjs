import { Device } from "./homewizard/device.mjs";
import { Webhook } from "./webhooks/webhook.mjs";

/**
 * energyid-homewizard-connector
 */
let initialized = false;
let hweDevice;
let energyid_hook = "";

const typeMap = [
	[
		"total_power_import_t1_kwh",
		{
			id: "electricity-import-day",
			name: "Electricity Import (day)",
			metric: "electricityImport",
			metricKind: "cumulative",
			unit: "kWh",
		},
	],
	[
		"total_power_import_t2_kwh",
		{
			id: "electricity-import-night",
			name: "Electricity Import (night)",
			metric: "electricityImport",
			metricKind: "cumulative",
			unit: "kWh",
		},
	],
	[
		"total_power_export_t1_kwh",
		{
			id: "electricity-export-day",
			name: "Electricity Export (day)",
			metric: "electricityExport",
			metricKind: "cumulative",
			unit: "kWh",
		},
	],
	[
		"total_power_export_t2_kwh",
		{
			id: "electricity-export-night",
			name: "Electricity Export (night)",
			metric: "electricityExport",
			metricKind: "cumulative",
			unit: "kWh",
		},
	],
	[
		"total_liter_m3",
		{
			id: "drinking-water-import",
			name: "Drinking Water Import",
			metric: "drinkingWaterImport",
			metricKind: "cumulative",
			unit: "m³",
		},
	],
];

class Reading {
	remoteName;

	constructor(type, date, value) {
		this.remoteId = type[1].id;
		this.remoteName = type[1].name;
		this.metric = type[1].metric;
		this.metricKind = type[1].metricKind;
		this.unit = type[1].unit;
		this.interval = "P1D";
		this.data = [[date, value]];
	}

	json() {
		return JSON.stringify(this);
	}
}

/**
 *  Private functions
 */
const setReadings = (data) => {
	console.log(data);
	const readings = [];
	const readingDate = new Date();
	readingDate.setMinutes(0, 0, 0);

	for (const type of typeMap) {
		if (data[type[0]]) {
			const value = (hweDevice.offset + data[type[0]]).toFixed(4);
			readings.push(new Reading(type, readingDate.toISOString(), value));
		}
	}
	return readings;
};

const sendReadings = (readings, dryRun) => {
	console.log(dryRun ? "Printing readings to console..." : "Sending readings to EnergyId Webhook...");
	const webhook = new Webhook("EnergyId", energyid_hook, "POST");

	for (const reading of readings) {
		if (dryRun) {
			console.log(`Reading to send: ${reading.json()}`);
			return;
		}

		try {
			webhook.send(reading.json());
		} catch (e) {
			// console.error(e.message);
		}
	}
};

/**
 * Public functions
 */

export const init = async (hwe, energyidWebhook, offset = 0) => {
	hweDevice = await Device.init(hwe, offset);
	energyid_hook = energyidWebhook;
	initialized = hweDevice instanceof Device && energyid_hook;
};

export const sync = async (dryRun = false) => {
	if (!initialized) {
		console.error('Configuration is missing, call "init" function first.');
		return;
	}

	const data = await hweDevice.update();
	if (!data) {
		return;
	}
	const readings = setReadings(data);
	setTimeout(() => {
		// Account for time discrepensies between local system and server
		sendReadings(readings, dryRun);
	}, 5000);
};
