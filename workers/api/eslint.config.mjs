import drizzlePlugin from 'eslint-plugin-drizzle';
import tseslint from 'typescript-eslint';
import rootConfig from '../../eslint.config.mjs';

export default tseslint.config({
	extends: [...rootConfig],
	plugins: {
		'@typescript-eslint': tseslint.plugin,
		drizzle: drizzlePlugin,
	},
	languageOptions: {
		parserOptions: {
			projectService: {
				allowDefaultProject: ['eslint.config.mjs'],
			},
			tsconfigRootDir: import.meta.dirname,
			ecmaFeatures: {
				jsx: true,
			},
		},
	},
	rules: {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		...drizzlePlugin.configs.recommended.rules,
	},
});
