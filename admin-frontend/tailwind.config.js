/** @type {import('tailwindcss').Config} */
export default {
  // Scoped to the new admin tree only. preflight is off and every base
  // rule in newadmin/index.css is scoped under .newadmin-root.
  //
  // Orange + White design system — every color used anywhere in the
  // dashboard must come from one of these six semantic scales (ink,
  // brand, accent, success, warning, danger). No arbitrary/one-off hex
  // values in component classNames — see the design system note in
  // newadmin/index.css.
  //   ink     — warm neutral (backgrounds, surfaces, text, borders)
  //   brand   — professional orange (primary actions, active states,
  //             focus rings, the one true accent color)
  //   accent  — secondary informational blue, used sparingly (e.g. an
  //             "in progress" status) — never a second primary color
  //   success/warning/danger — status semantics only
  content: ['./src/newadmin/**/*.{ts,tsx}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      fontFamily: {
        // Matches the Student Exam Portal's font stack exactly (see
        // root index.html / src/App.css --font-body/--font-display/
        // --font-mono): Inter for body/UI, Sora for display headings
        // (font-display), IBM Plex Mono for all tabular numbers and
        // technical labels (font-mono).
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Sora"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        // Warm-neutral scale (Tailwind's "stone" family) for a clean
        // white theme. Used SEMANTICALLY throughout the app: low numbers
        // are the lightest surfaces, high numbers the darkest text — the
        // standard light-theme ramp. `bg-ink-50` is the page canvas,
        // `border-ink-200` is a border, `text-ink-900` is heading text.
        ink: {
          50: '#fafaf9',  // page canvas / input fill (lightest)
          100: '#f5f5f4', // chips / neutral tints / hover backgrounds
          200: '#e7e5e4', // borders
          300: '#d6d3d1', // strong border / toggle-off track
          400: '#a8a29e', // most-muted text (timestamps, placeholders)
          500: '#78716c', // secondary text / labels
          600: '#57534e', // body text
          700: '#44403c', // strong body text
          800: '#292524',
          900: '#1c1917', // headings (near-black, darkest)
          950: '#0c0a09',
        },
        // Explicit surfaces — cards/modals/tables read as crisp white
        // against the slightly-tinted ink-50 page canvas.
        surface: {
          DEFAULT: '#ffffff', // cards, modals, tables
          raised: '#ffffff',  // elevated surface (toasts, popovers)
          sunken: '#f5f5f4',  // inset tiles on a card
          sidebar: '#ffffff', // the side rail
        },
        // Primary brand — warm deep orange. 600 is the default
        // interactive shade ("deep orange"); 500 is the lighter shade
        // used for secondary accents/tints; 700 is the pressed/hover-
        // darken shade for solid buttons.
        brand: {
          50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74',
          400: '#fb923c', 500: '#f97316', 600: '#ea580c', 700: '#c2410c',
          800: '#9a3412', 900: '#7c2d12', 950: '#431407',
        },
        // Secondary informational blue — deliberately distinct from
        // brand orange so it reads as "a different category," not a
        // second brand color. Used sparingly (e.g. a single status).
        accent: {
          50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd',
          400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8',
          800: '#1e40af', 900: '#1e3a8a',
        },
        success: {
          50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac',
          400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d',
          800: '#166534', 900: '#14532d',
        },
        warning: {
          50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d',
          400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309',
          800: '#92400e', 900: '#78350f',
        },
        danger: {
          50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5',
          400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c',
          800: '#991b1b', 900: '#7f1d1d',
        },
      },
      // Warm-tinted (not cool blue-black) and intentionally light —
      // "very soft shadows" per the design brief. `pop` (modals) gets a
      // little more spread for elevation but stays low-opacity.
      boxShadow: {
        card: '0 1px 2px 0 rgba(28, 25, 23, 0.04), 0 1px 2px 0 rgba(28, 25, 23, 0.03)',
        'card-hover': '0 4px 10px -2px rgba(28, 25, 23, 0.07), 0 2px 4px -2px rgba(28, 25, 23, 0.04)',
        pop: '0 16px 40px -12px rgba(28, 25, 23, 0.18), 0 4px 12px -4px rgba(28, 25, 23, 0.08)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-in-right': { from: { opacity: '0', transform: 'translateX(16px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'pulse-soft': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.5' } },
        'scale-in': { from: { opacity: '0', transform: 'scale(0.96)' }, to: { opacity: '1', transform: 'scale(1)' } },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.3s ease-out',
        'slide-in-right': 'slide-in-right 0.3s ease-out',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'scale-in': 'scale-in 0.15s ease-out',
      },
    },
  },
  plugins: [],
};
