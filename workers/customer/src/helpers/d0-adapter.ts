/**
 * Custom adapter for D1 API, attempting to keep same usability as `@auth/d1-adapter`
 * @link https://github.com/nextauthjs/next-auth/tree/main/packages/adapter-d1
 */

import type { Adapter } from '@auth/core/adapters';
import type * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

export function D0Adapter(platform: QwikCityPlatform, r_db: DrizzleD1Database<typeof rootSchema>, toCache: boolean): Adapter {
	function getUserDb(do_id_hex: string) {}

	return {
		// Users
		createUser: (user) => {},
		getUser: (id) => {},
		getUserByEmail: (email) => {},
		updateUser: (user) => {},
		// Oauth
		getUserByAccount: ({ provider, providerAccountId }) => {},
		getAccount: (providerAccountId, provider) => {},
		linkAccount: (account) => {},
		// Sessions
		createSession: (session) => {},
		getSessionAndUser: (sessionToken) => {},
		updateSession: ({ sessionToken, userId, expires, ...session }) => {},
		deleteSession: (sessionToken) => {},
		// Email magic links
		createVerificationToken: (verificationToken) => {},
		useVerificationToken: ({ identifier, token }) => {},
		// Passkeys
		getAuthenticator: (credentialID) => {},
		createAuthenticator: () => {},
		listAuthenticatorsByUserId: (userId) => {},
		updateAuthenticatorCounter: (credentialID, newCounter) => {},
	};
}
