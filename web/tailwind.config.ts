import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: '#FAF9F5', muted: '#F3F1EB' },
        ink: {
          50: '#F7F6F2', 100: '#EDEBE4', 200: '#D7D3C7', 300: '#B5AFA0', 400: '#8A8474',
          500: '#5F5A4D', 600: '#3F3B32', 700: '#2B2823', 800: '#1F1E1D', 900: '#14130F',
        },
        claude: {
          50: '#FBF1EC', 100: '#F5DCCF', 200: '#EEBFAA', 300: '#E69F7F', 400: '#DF8663',
          500: '#D97757', 600: '#B75E40', 700: '#8E4830', 800: '#653321', 900: '#3D1F14',
        },
        emerald: { 50: '#ECFDF5', 200: '#A7F3D0', 500: '#10B981', 700: '#047857' },
        rose: { 50: '#FFF1F2', 200: '#FECDD3', 500: '#F43F5E', 700: '#BE123C' },
      },
      borderRadius: { sm: '6px', md: '8px', lg: '12px', xl: '16px' },
      boxShadow: {
        card: '0 1px 2px rgba(31,30,29,.04), 0 4px 16px rgba(31,30,29,.06)',
        pop: '0 6px 24px rgba(31,30,29,.18)',
        sm: '0 1px 2px rgba(31,30,29,.06)',
        focus: '0 0 0 3px rgba(217,119,87,.22)',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Pretendard', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-in': 'fadeIn .2s cubic-bezier(.16,1,.3,1)',
      },
    },
  },
  plugins: [],
};

export default config;
