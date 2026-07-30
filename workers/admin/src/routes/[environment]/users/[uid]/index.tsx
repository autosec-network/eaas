import { component$ } from '@builder.io/qwik';
import type { RequestHandler } from '@builder.io/qwik-city';

/** The user root has no view of its own — properties is the first tab, and it gets a real segment so every tab is equally bookmarkable */
export const onRequest: RequestHandler = ({ params, url, redirect }) => {
	throw redirect(302, `/${params['environment']}/users/${params['uid']}/properties/${url.search}`);
};

export default component$(() => {
	return <></>;
});
