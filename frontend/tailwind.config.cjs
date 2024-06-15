/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ['./src/**/*.{js,ts,jsx,tsx,mdx,css}', './node_modules/flowbite/**/*.js'],
	darkMode: 'media',
	theme: {
		extend: {
			screens: {
				xxs: '320px',
			},
		},
	},
	plugins: [require('flowbite/plugin')],
};
