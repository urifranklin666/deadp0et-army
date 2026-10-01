/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Self-hosted (the CSP allows fonts from 'self' only).
        sans: ['"Inter Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        ink: { 950: "#05060a", 900: "#090b11", 850: "#0d1017", 800: "#12151e", 700: "#1a1e2a" },
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(244,63,94,.35), 0 8px 30px -12px rgba(244,63,94,.6)",
        lift: "0 12px 40px -12px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.06)",
      },
    },
  },
  plugins: [],
};
