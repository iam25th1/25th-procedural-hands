# Contributing

Thank you for looking. This library makes one promise: every hand it draws is built from published measurements and is held to them by a check. The rules below keep that promise true.

## The three rules

1. **Every anatomical value is cited.** A length, joint range, coupling ratio, girth or colour that stands for the human body carries its source in a comment beside it in the code: author, title or journal, year, and the table or figure it came from. Values that no source gives (a visual threshold, a design margin) say so in the comment, in those words. A new value with no source and no such note is not merged.
2. **No check is loosened to make a row pass.** A check is not deleted, skipped, re-baselined or given a wider limit because the code fails it. A limit changes only when a published source shows the check enforces something the anatomy contradicts; the commit then names that source and says what the old limit was. When a change makes a check fail, fix the change.
3. **The gate is green before a pull request.** Run `npm run gate` and open the pull request only when it passes. Say in the pull request what it printed.

## Setting up

```sh
npm ci --ignore-scripts          # Node 20 or newer
npx playwright install chromium  # the browser checks need it; --ignore-scripts does not fetch it
npm run gate
```

GitHub Actions runs the same gate on every push and pull request to main, on Linux and macOS (`.github/workflows/gate.yml`). A pull request is ready when both runs pass.

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
