import { component$, useServerData, useVisibleTask$ } from '@builder.io/qwik';
import { QwikCityProvider, RouterOutlet, ServiceWorkerRegister } from '@builder.io/qwik-city';
import { initFlowbite } from 'flowbite';
import { RouterHead } from './components/router-head/router-head';

import './global.less';

export default component$(() => {
	const nonce = useServerData<string | undefined>('nonce');

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
			<body lang="en">
				<RouterOutlet />
				<ServiceWorkerRegister nonce={nonce} />
				<script async defer src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"></script>
			</body>
		</QwikCityProvider>
	);
});
