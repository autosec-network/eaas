import { component$ } from '@builder.io/qwik';
import type { DocumentHead } from '@builder.io/qwik-city';

export const head: DocumentHead = {
	title: 'EaaS Admin - Redirecting...',
	meta: [
		{
			name: 'description',
			content: 'EaaS Admin - Redirecting to production environment',
		},
	],
};

export default component$(() => {
	return <></>;
});
