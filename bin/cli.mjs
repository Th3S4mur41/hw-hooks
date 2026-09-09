#! /usr/bin/env node

import cron from "node-cron";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { init, sync } from "../src/index.mjs";

// TODO: check node-cron for recursive solution
// https://www.npmjs.com/package/node-cron

const yargsBin = yargs(hideBin(process.argv))
	.usage("$0--energyid <energyid webhook>  --meter <homewizard meter host or ip> [options]")
	.option("e", {
		alias: "energyid",
		description: "URL of the EnergyId Webhook",
		type: "string",
	})
	.option("m", {
		alias: ["meter", "p", "p1"],
		description: "Hostname or IP address of the HomeWizard meter",
		type: "string",
	})
	.option("r", {
		alias: "recurring",
		description: "Run the task every hour",
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
	.version()
	.alias("v", "version");

const argv = yargsBin.argv;

if (!(argv.meter && argv.energyid)) {
	yargsBin.showHelp("log");
	process.exit(1);
}

console.log(`${process.env.npm_package_name} ${process.env.npm_package_version}`);
console.warn(
	"DEPRECATED: hw2energyid v1 is no longer maintained. Please migrate to hw-hooks v2: https://github.com/Th3S4mur41/hw-hooks",
);
console.log("");

init(argv.meter, argv.energyid, argv.offset);
if (argv.r) {
	console.log("Scheduling hw2energyid to run every hour");
	cron.schedule("1 * * * *", () => {
		sync(argv.d);
	});
} else {
	sync(argv.d);
}
