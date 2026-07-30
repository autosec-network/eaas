import { component$ } from '@builder.io/qwik';
import type { RequestHandler } from '@builder.io/qwik-city';

/** The tenant root has no view of its own — properties is the first tab, and it gets a real segment so every tab is equally bookmarkable */
export const onRequest: RequestHandler = ({ params, url, redirect }) => {
	throw redirect(302, `/${params['environment']}/tenants/${params['tid']}/properties/${url.search}`);
};

export default component$(() => {
	return <></>;
});
