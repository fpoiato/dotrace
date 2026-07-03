/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      colors: {
        race: {
          bg: '#0f172a',
          card: '#1e293b',
          accent: '#f97316',
          track: '#374151',
          grass: '#166534',
          finish: '#fbbf24',
        },
      },
    },
  },
  plugins: [],
};
