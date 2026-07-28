import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          purple: "#7c3aed",
          blue: "#2563eb",
          pink: "#ec4899"
        }
      }
    }
  },
  plugins: []
};

export default config;
