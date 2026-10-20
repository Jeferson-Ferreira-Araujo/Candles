/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        candleGreen: '#16a34a',
        candleRed: '#dc2626',
      },
      screens: {
        // Tela "de verdade" grande o bastante PRA ALTURA TAMBEM, nao so largura — sm: sozinho
        // (so largura >= 640px) tambem ativa em celular DEITADO, que e estreito em altura e
        // nao tem espaco pra sidebar completa/menus grandes feitos pra desktop/tablet.
        desk: { raw: '(min-width: 640px) and (min-height: 500px)' },
      },
    },
  },
  plugins: [],
};
