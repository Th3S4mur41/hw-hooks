import * as fs from "node:fs";
import * as path from "node:path";
import pino from "pino";
import { createStream } from "rotating-file-stream";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_LOG_FILE = "/app/logs/hw-hooks.log";

let logger = pino({ level: DEFAULT_LOG_LEVEL });
let fileStream;

export const resolveLogLevel = (cliLevel, environmentLevel) => {
	const level = cliLevel || environmentLevel || DEFAULT_LOG_LEVEL;
	if (!LOG_LEVELS.includes(level)) {
		throw new Error(`Invalid log level "${level}". Expected one of: ${LOG_LEVELS.join(", ")}`);
	}
	return level;
};

export const isFileLoggingEnabled = (value) => value === true || value === "true";

export const createLogger = ({ level = DEFAULT_LOG_LEVEL, fileEnabled = false, filePath = DEFAULT_LOG_FILE } = {}) => {
	const streams = [{ stream: process.stdout }];
	let rotatingStream;

	if (fileEnabled) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		rotatingStream = createStream(filePath, {
			interval: "1d",
			maxFiles: 7,
			compress: "gzip",
			path: ".",
		});
		streams.push({ stream: rotatingStream });
	}

	return { logger: pino({ level }, pino.multistream(streams)), fileStream: rotatingStream };
};

export const configureLogger = ({ level, fileEnabled, filePath } = {}) => {
	const configured = createLogger({ level, fileEnabled, filePath });
	logger = configured.logger;
	fileStream = configured.fileStream;
	return logger;
};

export const getLogger = () => logger;

export const closeLogger = async () => {
	logger.flush();
	if (fileStream) {
		await new Promise((resolve, reject) => {
			fileStream.once("error", reject);
			fileStream.end(resolve);
		});
		fileStream = undefined;
	}
};
