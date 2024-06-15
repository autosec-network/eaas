import rootConfig from '../prettier.config.mjs';

/** @type {import("prettier").Config} */
export default {
	...rootConfig,
	overrides: [
		...rootConfig.overrides,
		{
			files: '**',
			options: {
				plugins: [...(rootConfig.plugins ?? []), 'prettier-plugin-tailwindcss'],
			},
		},
	],
};
