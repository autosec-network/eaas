import { WorkerEntrypoint } from 'cloudflare:workers';
import type { DOJurisdictions } from 'types';
import { getWireStub, mintUniqueId, type DOLocator } from '../helpers/locator';
import type { BitwardenSession, EnvVars } from '../types';

export class BitwardenSessionProxy extends WorkerEntrypoint<EnvVars> {
	/**
	 * Mint a fresh session id (optionally jurisdictional), returned as a string — an id minted by the caller's local `workerd` namespace is rejected by the deployed namespace's `idFromString` ("Invalid Durable Object ID"), and `newUniqueId()` can't run under a jurisdiction locally anyway.
	 */
	newUniqueId(jurisdiction?: DOJurisdictions) {
		return mintUniqueId(this.env.BITWARDEN_SESSION, jurisdiction);
	}

	init(locator: DOLocator, ...args: Parameters<BitwardenSession['init']>) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).init(...args);
	}

	auth(locator: DOLocator, ...args: Parameters<BitwardenSession['auth']>) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).auth(...args);
	}

	getOrgEncryptionKey(locator: DOLocator, ...args: Parameters<BitwardenSession['getOrgEncryptionKey']>) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).getOrgEncryptionKey(...args);
	}

	getProjects(locator: DOLocator) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).getProjects();
	}

	getSecretsAndProjects(locator: DOLocator) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).getSecretsAndProjects();
	}

	getSecrets(locator: DOLocator, ...args: Parameters<BitwardenSession['getSecrets']>) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).getSecrets(...args);
	}

	setSecret(locator: DOLocator, ...args: Parameters<BitwardenSession['setSecret']>) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).setSecret(...args);
	}

	decryptSecret(locator: DOLocator, ...args: Parameters<BitwardenSession['decryptSecret']>) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).decryptSecret(...args);
	}

	encryptSecret(locator: DOLocator, ...args: Parameters<BitwardenSession['encryptSecret']>) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).encryptSecret(...args);
	}

	deleteSecrets(locator: DOLocator, ...args: Parameters<BitwardenSession['deleteSecrets']>) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).deleteSecrets(...args);
	}

	nuke(locator: DOLocator, ...args: Parameters<BitwardenSession['nuke']>) {
		return getWireStub(this.env.BITWARDEN_SESSION, locator).nuke(...args);
	}
}
