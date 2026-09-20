/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        candleGreen: '#16a34a',
        candleRed: '#dc2626',
      },
    },
  },
  plugins: [],
};
