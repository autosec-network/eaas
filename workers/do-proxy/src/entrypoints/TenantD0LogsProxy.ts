import { WorkerEntrypoint } from 'cloudflare:workers';
import { getWireStub, type DOLocator } from '../helpers/locator';
import type { EnvVars, TenantD0Logs } from '../types';

export class TenantD0LogsProxy extends WorkerEntrypoint<EnvVars> {
	sqlExec(locator: DOLocator, ...args: Parameters<TenantD0Logs['sqlExec']>) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator).sqlExec(...args);
	}

	optimize(locator: DOLocator) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator).optimize();
	}

	getBookmark(locator: DOLocator, ...args: Parameters<TenantD0Logs['getBookmark']>) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator).getBookmark(...args);
	}

	restoreToBookmark(locator: DOLocator, ...args: Parameters<TenantD0Logs['restoreToBookmark']>) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator).restoreToBookmark(...args);
	}

	nuke(locator: DOLocator, ...args: Parameters<TenantD0Logs['nuke']>) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator).nuke(...args);
	}

	schedule(locator: DOLocator, ...args: Parameters<TenantD0Logs['schedule']>) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator).schedule(...args);
	}

	getSchedule(locator: DOLocator, ...args: Parameters<TenantD0Logs['getSchedule']>) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator).getSchedule(...args);
	}

	getSchedules(locator: DOLocator, ...args: Parameters<TenantD0Logs['getSchedules']>) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator).getSchedules(...args);
	}

	cancelSchedule(locator: DOLocator, ...args: Parameters<TenantD0Logs['cancelSchedule']>) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator).cancelSchedule(...args);
	}

	_cleanupPendingWebsockets(locator: DOLocator) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator)._cleanupPendingWebsockets();
	}

	_optimizeDb(locator: DOLocator) {
		return getWireStub(this.env.TENANT_D0_LOGS, locator)._optimizeDb();
	}
}
