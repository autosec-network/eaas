import { component$, useTask$ } from '@builder.io/qwik';
import type { DocumentHead } from '@builder.io/qwik-city';
import { useSession } from '~/routes/plugin@auth';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
// import * as m from '~/paraglide/messages';

export default component$(() => {
	const sessionDump = useSession();

	useTask$(({ track }) => {
		track(() => sessionDump.value);
	});

	return (
		<div class="text-black dark:text-white">
			<h1>Hi 👋</h1>
			<div>
				Can't wait to see what you build with qwik!
				<br />
				Happy coding.
			</div>
			<pre>{JSON.stringify(sessionDump.value, null, '\t')}</pre>
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
