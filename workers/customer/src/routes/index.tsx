import type { Session } from '@auth/qwik';
import { component$ } from '@builder.io/qwik';
import type { DocumentHead, RequestHandler } from '@builder.io/qwik-city';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';

export const onRequest: RequestHandler = async ({ sharedMap, redirect }) => {
	const session = sharedMap.get('session') as Session;

	const r_db = sharedMap.get('r_db') as DrizzleD1Database<typeof rootSchema>;

	const tenants = await r_db
		.select({
			t_id: rootSchema.tenants.t_id,
		})
		.from(rootSchema.tenants)
		.innerJoin(rootSchema.users_tenants, eq(rootSchema.tenants.t_id, rootSchema.users_tenants.t_id))
		.where(eq(rootSchema.users_tenants.u_id, sql`unhex(${session.user?.u_id.hex})`));

	if (tenants.length < 1) {
		throw redirect(307, `/team/onboarding`);
	} else if (tenants.length === 1) {
		const { t_id } = tenants[0]!;

		// go into tenant
		throw redirect(307, `/team/${t_id.toString('base64url')}`);
	} else {
		// Go to tenant page
		throw redirect(307, '/team');
	}
};

export default component$(() => {
	return (
		<div class="text-black dark:text-white">
			<h1>Hi 👋</h1>
			<div>
				Can't wait to see what you build with qwik!
				<br />
				Happy coding.
			</div>
		</div>
	);
});

export const head: DocumentHead = {
	title: 'Welcome to Qwik',
	meta: [
		{
			name: 'description',
			content: 'Qwik site description',
		},
	],
};
