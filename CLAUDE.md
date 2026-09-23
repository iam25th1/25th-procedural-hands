# CLAUDE.md: 25th-procedural-hands

## Project
A standalone procedural hand and arm library for the browser, built on three and nothing else. Anatomical rig, per-finger control, IK, grasp and manipulation, an interaction physics layer, and a sandbox that exercises every capability. Mobile first. No game code lives here: the library is built to be consumed by a game.
The repo lives on the iam25th1 GitHub account as iam25th1/25th-procedural-hands. Never push to, clone or modify any other organisation's repository from this project, and stop if gh or git is authenticated as anything other than iam25th1.

## House rules
- Security first on every change. No inline scripts or eval; keep the CSP strict and report a violation instead of loosening it. The dev server serves only what is whitelisted.
- No em dashes anywhere: code, comments, UI strings, docs, commit messages.
- package-lock.json is committed, never gitignored. Every install uses --ignore-scripts and pins new dependencies exact (npm install <pkg> --save-exact --ignore-scripts). CI uses npm ci --ignore-scripts.
- hands/src imports nothing but three. That rule is enforced by a test in the gate, not by good intentions.
- Surgical changes to existing files; new systems go in new files.
- Gate every commit with npm run gate.
- Verify APIs, versions and facts against installed code or official docs, never from memory. Say plainly when something could not be verified.
- Never drop, stub or quietly shrink a requested feature. If something cannot be done, finish the rest and report exactly what is missing and why.
- Vestibular safety, absolute: no screen shake, camera recoil, head-bob, view sway, FOV punches, motion blur, chromatic aberration or full-screen flashes, and nothing flashes more than 3 times a second. The camera moves only from the user's own input. Respect prefers-reduced-motion and the Reduced motion setting.
- Visual rules: no purple, no gradients, no coloured bars down the side of cards or rows. UI is fully designed, never placeholder. anime.js v4 carries UI motion, checked against the installed typings, never v3 syntax.
- Mobile first: layout, controls and performance budgets start from phones in portrait and landscape, then scale up.
- Rich docs wherever a doc is produced: mermaid, LaTeX, collapsible <details>, animated SVG, a marked media placeholder. Living docs change in the same commit as the code they describe.
- Where visual, interactive or environment behaviour cannot be confirmed headlessly, say so and give the exact manual check.
- Commands handed to 25TH must fit the shell of the machine the task runs on: zsh on his Mac, PowerShell on Windows (where commands chain with ; not &&).
- Finish by pushing and opening a PR left open for review. Never merge.
