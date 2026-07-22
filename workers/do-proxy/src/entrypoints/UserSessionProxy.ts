import { WorkerEntrypoint } from 'cloudflare:workers';
import type { DOJurisdictions } from 'types';
import { getWireStub, mintUniqueId, type DOLocator } from '../helpers/locator';
import type { EnvVars, UserSession } from '../types';

export class UserSessionProxy extends WorkerEntrypoint<EnvVars> {
	/**
	 * Mint a fresh session-token id (optionally jurisdictional), returned as a string — the caller can't run `newUniqueId()` under a jurisdiction in local `workerd`.
	 */
	newUniqueId(jurisdiction?: DOJurisdictions) {
		return mintUniqueId(this.env.USER_SESSION, jurisdiction);
	}

	getProperties(locator: DOLocator, ...args: Parameters<UserSession['getProperties']>) {
		return getWireStub(this.env.USER_SESSION, locator).getProperties(...args);
	}

	getPropertiesSync(locator: DOLocator, ...args: Parameters<UserSession['getPropertiesSync']>) {
		return getWireStub(this.env.USER_SESSION, locator).getPropertiesSync(...args);
	}

	updateProperties(locator: DOLocator, ...args: Parameters<UserSession['updateProperties']>) {
		return getWireStub(this.env.USER_SESSION, locator).updateProperties(...args);
	}

	updatePropertiesSync(locator: DOLocator, ...args: Parameters<UserSession['updatePropertiesSync']>) {
		return getWireStub(this.env.USER_SESSION, locator).updatePropertiesSync(...args);
	}

	nuke(locator: DOLocator, ...args: Parameters<UserSession['nuke']>) {
		return getWireStub(this.env.USER_SESSION, locator).nuke(...args);
	}
}
