/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        felt: {
          DEFAULT: '#0b6e3d',
          dark: '#073f23',
        },
      },
    },
  },
  plugins: [],
};
