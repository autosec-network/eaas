import { component$ } from '@builder.io/qwik';
import type { DocumentHead } from '@builder.io/qwik-city';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

export default component$(() => {
	return (
		<div class="text-black dark:text-white">
			<h1>Hi 👋</h1>
			<h2>{m.login_header()}</h2>
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
