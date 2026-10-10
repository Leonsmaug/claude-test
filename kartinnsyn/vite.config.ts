import { defineConfig } from "vite";

// Relativ base gjør at bygget kan legges i hvilken som helst mappe på et CDN,
// i en objektlagringsbøtte eller på GitHub Pages uten endringer.
export default defineConfig({
  base: "./",
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});
