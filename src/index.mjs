/**
 * energyid-homewizard-connector
 */
let initialized = false;
let hwe_api = "";
let energyid_hook = "";
let readingOffset = 0;

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
 *  Provate functions
 */

const getData = async () => {
	console.log("Retrieving data from Homewizard API...");

	return fetch(hwe_api)
		.then((result) => {
			console.log("HomeWizard Meter data:");
			return result.json();
		})
		.then((data) => {
			console.log(data);
			return data;
		})
		.catch((_error) => {
			console.error(`Cannot retreive data from ${hwe_api}`);
		});
};

const setReadings = (data) => {
	console.log(data);
	const readings = [];
	const readingDate = new Date();
	readingDate.setMinutes(0, 0, 0);

	for (const type of typeMap) {
		if (data[type[0]]) {
			const value = (readingOffset + data[type[0]]).toFixed(4);
			readings.push(new Reading(type, readingDate.toISOString(), value));
		}
	}
	return readings;
};

const sendReadings = (readings, dryRun) => {
	console.log(dryRun ? "Printing readings to console..." : "Sending readings to EnergyId Webhook...");
	for (const reading of readings) {
		if (dryRun) {
			console.log(`Reading to send: ${reading.json()}`);
			return;
		}
		fetch(energyid_hook, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: reading.json(),
		})
			.then((response) => {
				if (!response.ok) {
					throw new Error(`Error sending reading: ${reading.json()}`);
				}
				console.log(`Sending reading: ${reading.json()}`);
			})
			.catch((e) => {
				console.error(e.message);
			});
	}
};

/**
 * Public functions
 */

export const init = (hwe, energyidWebhook, offset = 0) => {
	hwe_api = `http://${hwe}/api/v1/data/`;
	energyid_hook = energyidWebhook;
	initialized = hwe_api && energyid_hook;

	if (Number.isNaN(Number.parseFloat(offset))) {
		readingOffset = 0;
	} else {
		readingOffset = Number.parseFloat(offset);
	}
};

export const sync = async (dryRun = false) => {
	if (!initialized) {
		console.error('Configuration is missing, call "init" function first.');
		return;
	}

	const data = await getData();
	if (!data) {
		return;
	}
	const readings = setReadings(data);
	setTimeout(() => {
		// Account for time discrepensies between local system and server
		sendReadings(readings, dryRun);
	}, 5000);
};
