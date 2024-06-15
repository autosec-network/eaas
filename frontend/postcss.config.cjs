module.exports = {
	content: ['./src/**/*.{html,js}'],
	plugins: {
		'postcss-import': {},
		'tailwindcss/nesting': 'postcss-nesting',
		'postcss-nesting': {
			edition: '2024-02',
		},
		tailwindcss: {},
		autoprefixer: {},
	},
};
