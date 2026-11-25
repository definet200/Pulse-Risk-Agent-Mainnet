import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0e0f14',
        panel: '#14151b',
        panel2: '#1a1c23',
        line: '#23252e',
        muted: '#8a8f9c',
        up: '#00c278',
        down: '#ff5b5b',
        accent: '#f0b90b',
      },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
} satisfies Config;
