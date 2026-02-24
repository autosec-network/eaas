import type { LogWriter } from 'drizzle-orm/logger';

export namespace StaticDatabase {
	export enum Root {
		eaas_root = 'c576d6cf-f202-4845-a971-f95d0e00e95a',
		eaas_root_p = 'fdb26d0f-eb5c-4c62-9c01-2d50274e45af',
	}
}

export type CustomLogCallback = (message: string) => void;

class DebugLogWriter implements LogWriter {
	private dbId: StaticDatabase.Root | string;

	constructor(dbId: typeof this.dbId) {
		this.dbId = dbId;
	}

	write(...args: Parameters<LogWriter['write']>) {
		console.debug(new Date().toISOString(), '|', this.dbId.toLowerCase(), '|', ...args);
	}
}
