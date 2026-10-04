/** @type {import('tailwindcss').Config} */
// The console wears the same materials as the marketing site: black stage,
// paper artifacts, one red signal, acid for "live", cyan for other people.
// Hard offset shadows and square corners — cut paper, not glass.
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Self-hosted (the CSP allows fonts from 'self' only).
        sans: ['"Inter Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
        display: ['"Archivo Black"', "Impact", "ui-sans-serif", "sans-serif"],
      },
      colors: {
        ink: { 950: "#070707", 900: "#0e0e0d", 850: "#151513", 800: "#1c1c19", 700: "#2a2a25" },
        paper: { DEFAULT: "#e9e4d8", dim: "#b8b3aa" },
        dim: "#8c8880",
        blood: "#f03224",
        acid: "#d8ff38",
        ice: "#51e8df",
      },
      boxShadow: {
        hard: "4px 4px 0 #f03224",
        "hard-sm": "3px 3px 0 #f03224",
        "hard-xs": "2px 2px 0 #f03224",
        "hard-lg": "10px 10px 0 #f03224",
        "hard-paper": "4px 4px 0 #e9e4d8",
        pop: "4px 4px 0 rgba(233,228,216,.14)",
      },
      letterSpacing: { eyebrow: "0.15em", label: "0.12em" },
    },
  },
  plugins: [],
};
