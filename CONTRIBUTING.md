# Contributing

Thank you for looking. This library makes one promise: every hand it draws is built from published measurements and is held to them by a check. The rules below keep that promise true.

## The three rules

1. **Every anatomical value is cited.** A length, joint range, coupling ratio, girth or colour that stands for the human body carries its source in a comment beside it in the code: author, title or journal, year, and the table or figure it came from. Values that no source gives (a visual threshold, a design margin) say so in the comment, in those words. A new value with no source and no such note is not merged.
2. **No check is loosened to make a row pass.** A check is not deleted, skipped, re-baselined or given a wider limit because the code fails it. A limit changes only when a published source shows the check enforces something the anatomy contradicts; the commit then names that source and says what the old limit was. When a change makes a check fail, fix the change.
3. **The gate is green before a pull request.** Run `npm run gate` on your machine and open the pull request only when it passes, device-dependent checks included. Say in the pull request what it printed. CI runs `npm run gate:ci` as well; see below.

## Setting up

```sh
npm ci --ignore-scripts          # Node 20 or newer
npx playwright install chromium  # the browser checks need it; --ignore-scripts does not fetch it
npm run gate
```

## Two gates: what CI enforces and what only your machine can

| Command | Where | Runs |
| --- | --- | --- |
| `npm run gate` | Your machine, before every commit and pull request | Every check, device-dependent ones included |
| `npm run gate:ci` | GitHub Actions on every push and pull request to main, on x64 Linux, arm64 Linux and arm64 macOS (`.github/workflows/gate.yml`) | Every machine-independent check; the device-dependent ones are named as not run |

`npm run gate:ci` is `npm run gate` with `--set=ci` given to `hands:check` and `hands:matrix`. It leaves out only the checks that carry a `device` reason in their definition. Nothing is softened or turned into a warning: a device-dependent check keeps its limit, stays in `npm run gate`, and fails loudly on hardware that cannot meet it.

<details>
<summary>The device-dependent checks, and why a shared runner cannot hold them</summary>

| Check | Why it is device-dependent |
| --- | --- |
| `budget: rig step ms, median, hands module alone in Node` | Wall-clock time per step; the limit was set on the machine the budgets were measured on |
| `budget: sim step ms, median, sandbox loaded in Node` | The same, for the whole sandbox step |
| `budget: sim step ms, median / 95th percentile / worst step, sandbox loaded live in a browser` (three checks) | Wall-clock time per step in a browser, the figure the perf overlay shows |
| `planning: switching actions and cold solves after a slider move never hold a frame` | Wall-clock frame time in a browser, with that machine's GPU, CPU and scheduler |
| `video: offline renders at 1920x1080 and 2560x1440 ...` | 642 frames at 1080p and 1440p must render and encode inside a 120 s wait, on that machine's GPU and with its browser's encoders |

A shared CI runner is a few virtual CPUs of unknown speed, shared with other jobs, with software or virtual GPUs. The first CI run measured the Node sim step at 2.2 ms against a 1.2 ms limit, the live step p95 at 10.7 to 15.5 ms against 4.5 ms, and a planning frame at 117 to 667 ms against 50 ms. The Linux video render did not finish inside its 120 s wait. Those limits describe the phones and laptops the library is built for, measured on real hardware. A slow virtual machine failing them says nothing about the code, and a run passing them there would say nothing either. Run `npm run gate` on your machine, and on a device when a change could affect speed.

Everything else is machine-independent: counts, geometry, anatomy, physics, grips, contacts, colour against its swatches, the UI's layout, and replay, which must be bit for bit the same on every engine and CPU. CI holds all of it on three platforms.

</details>

## Working rules

- **Installs never run package scripts, and new dependencies are pinned exactly**: `npm install <pkg> --save-exact --ignore-scripts`. `package-lock.json` is committed.
- **`hands/src` imports nothing but `three`**, and only `three-view.js` imports that. No DOM, no `window`, no `document`. `test/isolation.test.js` enforces it.
- **After any change to `hands/src` or `app/scenes`, run `npm run hands:plans`** to rebuild the recorded plan table; `hands:check` fails while it is stale.
- **The sandbox keeps a strict Content Security Policy**: no inline scripts or styles, no `eval`, and the dev server serves only whitelisted files. If something needs the policy loosened, report it rather than loosening it.
- **No em dashes** in code, comments, UI strings, docs or commit messages. `npm run check` looks for them.
- **Motion safety**: the camera moves only from the user's input. No screen shake, recoil, head-bob, sway, FOV punches, motion blur, chromatic aberration or full-screen flashes, nothing flashing more than three times a second, and `prefers-reduced-motion` is respected.
- **Mobile first**: layout, controls and performance budgets start from phones in portrait and landscape.
- **Docs change with the code.** If a change alters what [README.md](README.md) or [hands/README.md](hands/README.md) says, update them in the same commit.
- **New systems go in new files**; changes to existing files stay as small as the change needs.

## What a check looks like

A check is a named row in `npm run hands:check` with its worst measured value, its limit and a note of where the limit comes from. If you add a capability, [hands/README.md](hands/README.md#how-to-add-a-capability) has the steps: a scenario, what it must achieve, a plan table rebuild and a row in the capability matrix.

<details>
<summary>Things a headless run cannot confirm</summary>

The gate renders in headless Chromium, which is not a phone. If your change affects how something looks, feels or performs on a device, say in the pull request what you checked by hand and on what: for example, the sandbox on a phone in portrait and landscape, the perf overlay's step times on that phone, or a gesture read at full speed.

</details>

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE) of this repository.
