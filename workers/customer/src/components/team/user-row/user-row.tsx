import { Resource, component$, useResource$ } from '@builder.io/qwik';
import { server$ } from '@builder.io/qwik-city';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import { createHash } from 'node:crypto';
import { resolveDoStub } from '~/helpers/do-proxy';

const getUserProperties = server$(async function (u_id_hex: string, do_id: string) {
	const r_db = this.sharedMap.get('r_db') as DrizzleD1Database;

	const [user] = await r_db
		.select({ jurisdiction: rootSchema.users.jurisdiction })
		.from(rootSchema.users)
		.where(eq(rootSchema.users.u_id, sql`unhex(${u_id_hex})`))
		.limit(1);

	if (user) {
		const doStub = resolveDoStub(this.platform, this.platform.env.USER_D0, this.platform.env.USER_D0_PROXY, { id: do_id, jurisdiction: user.jurisdiction ?? undefined });
		const { email } = await doStub.getProperties({ email: true }, true);

		if (email) {
			const emailHash = createHash('sha256').update(email).digest('hex');
			const gravatarUrl = new URL(['avatar', emailHash].join('/'), 'https://gravatar.com');
			gravatarUrl.searchParams.set('d', 'robohash');

			return { email, avatar: gravatarUrl.href };
		} else {
			throw new Error('Email not found for user');
		}
	} else {
		throw new Error('User not found');
	}
});

interface Props {
	u_id_hex: string;
	do_id: string;
}

export default component$<Props>(({ u_id_hex, do_id }) => {
	const data = useResource$(() => getUserProperties(u_id_hex, do_id));

	return (
		<div class="flex items-center gap-3">
			<Resource
				value={data}
				onPending={() => (
					<>
						<div class="h-9 w-9 animate-pulse rounded-full bg-gray-300 dark:bg-gray-600" />
						<div class="min-w-0 flex-1">
							<div class="h-3.5 w-28 animate-pulse rounded bg-gray-300 dark:bg-gray-600" />
						</div>
					</>
				)}
				onResolved={(user) => (
					<>
						{user.avatar ? <img src={user.avatar} alt={user.email} width={36} height={36} class="h-9 w-9 rounded-full object-cover" /> : <div class="bg-primary-accent/10 text-primary-accent dark:bg-primary-accent/20 flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold">{user.email ? user.email.charAt(0).toUpperCase() : '?'}</div>}
						<span class="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-white">{user.email}</span>
					</>
				)}
				onRejected={() => (
					<>
						<div class="bg-primary-accent/10 text-primary-accent dark:bg-primary-accent/20 flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold">?</div>
						<span class="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-white">???</span>
					</>
				)}
			/>
		</div>
	);
});
