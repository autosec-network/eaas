import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import type { DOJurisdictions } from 'types';
import * as zm from 'zod/mini';
import { isNukedError } from '~/routes/[environment]/tenants/tenant-ops';
import { hexToUuid } from '~/routes/[environment]/users/db-helpers';
import type { EnvVars } from '~/types';

/** The route param is always the short form, so user links stay copy-pasteable */
export const userIdParamSchema = zm.base64url().check(zm.length(22));

/** The stub the `[uid]` layout puts on `sharedMap` for its tabs to read */
export type UserDoStub = ReturnType<EnvVars['USER_D0_PROD']['get']>;

/**
 * Derives the user's DO id. Falls back to `idFromName` (how sign-up mints it) when the root row has no `do_id` yet, so a user who has never signed in still resolves instead of 404ing.
 */
export function resolveUserDoId(namespace: EnvVars['USER_D0_PROD'], jurisdiction: DOJurisdictions | null, u_id_hex: string, do_id_hex?: string | null) {
	const jurisdictionalNamespace = jurisdiction ? namespace.jurisdiction(jurisdiction) : namespace;
	return do_id_hex ? jurisdictionalNamespace.idFromString(do_id_hex) : jurisdictionalNamespace.idFromName(hexToUuid(u_id_hex));
}

/**
 * Deletes a user everywhere they exist: the root row (whose cascades clear every link table), their Durable Object, and the Durable Object behind each of their sessions.
 *
 * The session tokens have to be read before the root row goes away — the cascade takes `users_auth_sessions` with it, and a session's DO id is that token. A failed wipe throws, leaving nothing but stranded storage behind.
 */
export async function purgeUser(options: { r_db: DrizzleD1Database; u_id_hex: string; userNamespace: EnvVars['USER_D0_PROD']; sessionNamespace: EnvVars['USER_SESSION_PROD'] }) {
	const { r_db, u_id_hex, userNamespace, sessionNamespace } = options;

	const sessions = await r_db
		.select({
			session_token: rootSchema.users_auth_sessions.session_token,
		})
		.from(rootSchema.users_auth_sessions)
		.where(eq(rootSchema.users_auth_sessions.u_id, sql`unhex(${u_id_hex})`))
		.then((rows) => rows.map((row) => row.session_token.toString('hex')));

	const [deletedUser] = await r_db
		.delete(rootSchema.users)
		.where(eq(rootSchema.users.u_id, sql`unhex(${u_id_hex})`))
		.returning({
			jurisdiction: rootSchema.users.jurisdiction,
			do_id: rootSchema.users.do_id,
		})
		.then((rows) =>
			rows.map((row) => ({
				...row,
				do_id: row.do_id?.toString('hex') ?? null,
			})),
		);

	await Promise.allSettled([
		(async () => {
			// A user who never signed in has no durable object to wipe
			if (deletedUser?.do_id) {
				await userNamespace.get(resolveUserDoId(userNamespace, deletedUser.jurisdiction, u_id_hex, deletedUser.do_id)).nuke('User deleted');
			}
		})(),
		...sessions.map(async (session_token) => {
			const jurisdictionalNamespace = deletedUser?.jurisdiction ? sessionNamespace.jurisdiction(deletedUser.jurisdiction) : sessionNamespace;
			await sessionNamespace.get(jurisdictionalNamespace.idFromString(session_token)).nuke('User deleted');
		}),
	]).then((settled) => {
		const errors = settled
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			// eslint-disable-next-line @typescript-eslint/no-unsafe-return
			.map((result) => result.reason)
			// Both `nuke()` calls above always reject on success too — that's not a failure, so it must not be counted as one
			.filter((error) => !isNukedError(error));

		if (errors.length > 0) throw new AggregateError(errors, 'Failed to wipe one or more of the user durable objects/sessions');
	});
}
