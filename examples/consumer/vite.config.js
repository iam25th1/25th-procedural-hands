import { defineConfig } from 'vite';

// The library is linked from the repository root (file:../..), which has
// its own copy of three for the sandbox. Deduping makes the example and the
// library share one three, as they would when installed from npm.
export default defineConfig({
  resolve: { dedupe: ['three'] },
});
