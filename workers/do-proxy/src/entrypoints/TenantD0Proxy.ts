import { WorkerEntrypoint } from 'cloudflare:workers';
import { deriveId, getWireStub, type DOLocator } from '../helpers/locator';
import type { EnvVars, TenantD0 } from '../types';

export class TenantD0Proxy extends WorkerEntrypoint<EnvVars> {
	/**
	 * Resolve a {@link DOLocator} to its hex `DurableObjectId` string. Lets a caller that can't run jurisdictional `idFromName` in local `workerd` obtain the id it must persist (e.g. a tenant's `do_id`).
	 */
	resolveId(locator: DOLocator) {
		return deriveId(this.env.TENANT_D0, locator).toString();
	}

	sqlExec(locator: DOLocator, ...args: Parameters<TenantD0['sqlExec']>) {
		return getWireStub(this.env.TENANT_D0, locator).sqlExec(...args);
	}

	optimize(locator: DOLocator) {
		return getWireStub(this.env.TENANT_D0, locator).optimize();
	}

	getBookmark(locator: DOLocator, ...args: Parameters<TenantD0['getBookmark']>) {
		return getWireStub(this.env.TENANT_D0, locator).getBookmark(...args);
	}

	restoreToBookmark(locator: DOLocator, ...args: Parameters<TenantD0['restoreToBookmark']>) {
		return getWireStub(this.env.TENANT_D0, locator).restoreToBookmark(...args);
	}

	nuke(locator: DOLocator, ...args: Parameters<TenantD0['nuke']>) {
		return getWireStub(this.env.TENANT_D0, locator).nuke(...args);
	}

	purge(locator: DOLocator, ...args: Parameters<TenantD0['purge']>) {
		return getWireStub(this.env.TENANT_D0, locator).purge(...args);
	}

	registerBitwardenSession(locator: DOLocator, ...args: Parameters<TenantD0['registerBitwardenSession']>) {
		return getWireStub(this.env.TENANT_D0, locator).registerBitwardenSession(...args);
	}

	listBitwardenSessions(locator: DOLocator, ...args: Parameters<TenantD0['listBitwardenSessions']>) {
		return getWireStub(this.env.TENANT_D0, locator).listBitwardenSessions(...args);
	}

	unregisterBitwardenSession(locator: DOLocator, ...args: Parameters<TenantD0['unregisterBitwardenSession']>) {
		return getWireStub(this.env.TENANT_D0, locator).unregisterBitwardenSession(...args);
	}

	schedule(locator: DOLocator, ...args: Parameters<TenantD0['schedule']>) {
		return getWireStub(this.env.TENANT_D0, locator).schedule(...args);
	}

	getSchedule(locator: DOLocator, ...args: Parameters<TenantD0['getSchedule']>) {
		return getWireStub(this.env.TENANT_D0, locator).getSchedule(...args);
	}

	getSchedules(locator: DOLocator, ...args: Parameters<TenantD0['getSchedules']>) {
		return getWireStub(this.env.TENANT_D0, locator).getSchedules(...args);
	}

	cancelSchedule(locator: DOLocator, ...args: Parameters<TenantD0['cancelSchedule']>) {
		return getWireStub(this.env.TENANT_D0, locator).cancelSchedule(...args);
	}

	getProperties(locator: DOLocator, ...args: Parameters<TenantD0['getProperties']>) {
		return getWireStub(this.env.TENANT_D0, locator).getProperties(...args);
	}

	getPropertiesSync(locator: DOLocator, ...args: Parameters<TenantD0['getPropertiesSync']>) {
		return getWireStub(this.env.TENANT_D0, locator).getPropertiesSync(...args);
	}

	updateProperties(locator: DOLocator, ...args: Parameters<TenantD0['updateProperties']>) {
		return getWireStub(this.env.TENANT_D0, locator).updateProperties(...args);
	}

	updatePropertiesSync(locator: DOLocator, ...args: Parameters<TenantD0['updatePropertiesSync']>) {
		return getWireStub(this.env.TENANT_D0, locator).updatePropertiesSync(...args);
	}
}
