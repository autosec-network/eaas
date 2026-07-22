import { WorkerEntrypoint } from 'cloudflare:workers';
import { getWireStub, type DOLocator } from '../helpers/locator';
import type { EnvVars, UserD0 } from '../types';

export class UserD0Proxy extends WorkerEntrypoint<EnvVars> {
	sqlExec(locator: DOLocator, ...args: Parameters<UserD0['sqlExec']>) {
		return getWireStub(this.env.USER_D0, locator).sqlExec(...args);
	}

	optimize(locator: DOLocator) {
		return getWireStub(this.env.USER_D0, locator).optimize();
	}

	getBookmark(locator: DOLocator, ...args: Parameters<UserD0['getBookmark']>) {
		return getWireStub(this.env.USER_D0, locator).getBookmark(...args);
	}

	restoreToBookmark(locator: DOLocator, ...args: Parameters<UserD0['restoreToBookmark']>) {
		return getWireStub(this.env.USER_D0, locator).restoreToBookmark(...args);
	}

	nuke(locator: DOLocator, ...args: Parameters<UserD0['nuke']>) {
		return getWireStub(this.env.USER_D0, locator).nuke(...args);
	}

	schedule(locator: DOLocator, ...args: Parameters<UserD0['schedule']>) {
		return getWireStub(this.env.USER_D0, locator).schedule(...args);
	}

	getSchedule(locator: DOLocator, ...args: Parameters<UserD0['getSchedule']>) {
		return getWireStub(this.env.USER_D0, locator).getSchedule(...args);
	}

	getSchedules(locator: DOLocator, ...args: Parameters<UserD0['getSchedules']>) {
		return getWireStub(this.env.USER_D0, locator).getSchedules(...args);
	}

	cancelSchedule(locator: DOLocator, ...args: Parameters<UserD0['cancelSchedule']>) {
		return getWireStub(this.env.USER_D0, locator).cancelSchedule(...args);
	}

	_cleanupVerificationTokens(locator: DOLocator) {
		return getWireStub(this.env.USER_D0, locator)._cleanupVerificationTokens();
	}

	getProperties(locator: DOLocator, ...args: Parameters<UserD0['getProperties']>) {
		return getWireStub(this.env.USER_D0, locator).getProperties(...args);
	}

	getPropertiesSync(locator: DOLocator, ...args: Parameters<UserD0['getPropertiesSync']>) {
		return getWireStub(this.env.USER_D0, locator).getPropertiesSync(...args);
	}

	updateProperties(locator: DOLocator, ...args: Parameters<UserD0['updateProperties']>) {
		return getWireStub(this.env.USER_D0, locator).updateProperties(...args);
	}

	updatePropertiesSync(locator: DOLocator, ...args: Parameters<UserD0['updatePropertiesSync']>) {
		return getWireStub(this.env.USER_D0, locator).updatePropertiesSync(...args);
	}
}
