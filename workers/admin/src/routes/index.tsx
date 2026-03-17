import { component$ } from '@builder.io/qwik';
import type { DocumentHead } from '@builder.io/qwik-city';

export const head: DocumentHead = {
	title: 'Sushidata Admin - Redirecting...',
	meta: [
		{
			name: 'description',
			content: 'Sushidata Admin - Redirecting to production environment',
		},
	],
};

export default component$(() => {
	return <></>;
});
