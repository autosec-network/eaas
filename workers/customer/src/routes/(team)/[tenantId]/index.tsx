import { component$, Resource } from '@builder.io/qwik';
import { routeLoader$ } from '@builder.io/qwik-city';
import type { TenantD0 } from '~/types';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

// eslint-disable-next-line qwik/loader-location
const useTenantProperties = routeLoader$(({ sharedMap }) => async () => {
	const t_do = sharedMap.get('t_do') as DurableObjectStub<TenantD0>;

	return t_do.getProperties(undefined, true);
});

export default component$(() => {
	const tenantProperties = useTenantProperties();

	return (
		<Resource
			value={tenantProperties}
			onPending={() => <p>{m.common_loading()}</p>}
			onResolved={(data) => <pre class="text-black dark:text-white">{JSON.stringify(data, null, '\t')}</pre>}
			onRejected={(error) =>
				error instanceof Error ? (
					<p class="text-red">
						{m.common_error_label()} {error.name}: {error.message} (<pre class="text-red">{JSON.stringify(error.stack, null, '\t')}</pre>)
					</p>
				) : (
					<pre class="text-red">{JSON.stringify(error, null, '\t')}</pre>
				)
			}
		/>
	);
});
