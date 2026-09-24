# Consumer example

The library used from outside itself: a fresh three.js scene that imports `25th-procedural-hands` by its package name, adds the hands to its own scene, and has the right hand count one to five while the left hand waves. Everything is in [`main.js`](main.js).

```sh
cd examples/consumer
npm ci --ignore-scripts
npm run dev
```

Then open the URL Vite prints. The library is linked from the repository root (`"25th-procedural-hands": "file:../.."`); in your own project you would install it with `npm install 25th-procedural-hands three` instead, and the code stays the same.

Vite is used because an ES module importing bare package names (`'three'`, `'25th-procedural-hands'`) needs either a bundler or an import map, and an import map is an inline script, which this repository's pages do not use.
