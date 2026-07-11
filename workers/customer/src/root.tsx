import { component$, useVisibleTask$ } from '@builder.io/qwik';
import { QwikCityProvider, RouterOutlet } from '@builder.io/qwik-city';
import { initFlowbite } from 'flowbite';
import { RouterHead } from '~/components/router-head/router-head';

import './global.css';

export default component$(() => {
	// eslint-disable-next-line qwik/no-use-visible-task
	useVisibleTask$(() => {
		initFlowbite();
	});

	return (
		<QwikCityProvider>
			<head>
				<meta charset="utf-8" />
				<link rel="manifest" href="/manifest.json" />
				<RouterHead />
			</head>
			<body lang="en" class="bg-deep-light dark:bg-deep-dark">
				<RouterOutlet />
			</body>
		</QwikCityProvider>
	);
});
