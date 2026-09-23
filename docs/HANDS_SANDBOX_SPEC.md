# Spec: 25th-procedural-hands, standalone module and interaction sandbox

You are working in the 25th-procedural-hands folder, which is not a git repo yet. Create the repo on the iam25th1 account, port the existing procedural hand rig out of a read-only snapshot into a standalone library, widen it to the full capability set below, and build an interaction sandbox that exercises every capability. Push + open a PR against main when done, leave it open for review.

SOURCE: the source snapshot is a read-only copy of the rig. Read from it freely, never write to it, and never add it to this repo as a dependency. Everything you keep gets copied in and restructured here.
ISOLATION: other work may be running on the same machine at the same time. Never open, read, write or run anything outside this repository and the read-only source snapshot.

House rules: CLAUDE.md applies in full (security first; no em dashes anywhere; lockfile committed; installs use --ignore-scripts with exact pins; hands/src imports only three; surgical changes; verify APIs against installed code; never drop or stub a feature; vestibular safety; no purple, gradients or side bars; mobile first; rich docs). Gate every commit with npm run gate. Units are meters. Default dev entry point: PORT=3100 npm start, then the sandbox URL the server prints.

## PHASE 0 - BOOTSTRAP (report, then continue in the same run)

- Before touching git, confirm the account: gh auth status must show iam25th1 as the active github.com account, and git config user.email must be the iam25th1 address. If either shows any other account, stop and report.
- Confirm the source snapshot exists and list what is in it. If it is missing or empty, stop and report.
- git init -b main, commit this spec and CLAUDE.md as the seed, then gh repo create iam25th1/25th-procedural-hands --private --source . --push. Confirm with gh repo view iam25th1/25th-procedural-hands --json nameWithOwner,isPrivate.
- Branch feat/hands-sandbox from main. All build work happens there.

## PHASE 1 - RECON (report, then build in the same run)

- Inventory the source snapshot: every file belonging to the rig, what each exports, and which files consume it. Quote the import lines.
- List every dependency the rig has on that project's game code (constants, map, sim, server, anything else). For each, say whether it moves into the module, becomes an injected option with a default, or gets left behind.
- Name the module's public API before writing it: creation, update, pose and gesture control, per-finger control, grasp and manipulation, attachment, events, teardown.
- Report the plan for the repo skeleton, the interaction physics layer, the capability matrix and the sandbox scenes.

## PHASE 2 - BUILD (logically grouped commits)

=== COMMIT 1 - Repo skeleton and dev server ===
- package.json: private, type module, scripts start, check (node --check over every source folder), test (node --test, no new test deps), hands:check, hands:matrix, hands:gallery, gate (check, test, hands:check, hands:matrix, npm audit --audit-level=high). engines node >=20.
- Dependencies pinned exact with --ignore-scripts: three (latest stable, report the version), playwright as a dev dependency, @fontsource/alfa-slab-one and @fontsource/barlow-condensed with their woff2 subsets and OFL files vendored into the app.
- A small static dev server: path containment (no traversal, no dotfiles, no directory listings), a /vendor/ route serving an explicit file whitelist from node_modules and nothing else, strict CSP with no inline scripts and no eval, nosniff, frame-ancestors none. It prints the sandbox URL, local and LAN, on boot, and exits with a clear message when the port is taken. Default port 3100.
- .gitignore covering node_modules, artifacts and local env. Tests for traversal, the vendor whitelist and the port message.

=== COMMIT 2 - The module ===
- Port the rig from the source snapshot into hands/src, with hands/test for its tests and hands/README.md for its own doc. The only import from outside hands/ is three.
- Public API in hands/src/index.js covering at least: create, update(dt), setPose, blendPose, setFinger(hand, finger, curl, spread), setFingerJoint, gesture(name), grasp(object, gripType), release, attach, detach, IK targets, events (contact, grasped, released, slipped), dispose.
- The module is DOM free so all of it runs under node --test. Any browser-only glue lives in the sandbox app, not in hands/src.
- Values that came from the old project's constants (skin tones, sleeve colours, object sizes) become options with defaults inside the module.
- Isolation test in the gate: parse every file under hands/src and fail if an import resolves outside hands/ or is anything other than three, or if window or document is touched.
- Carry over every test that came with the rig and keep it green.

=== COMMIT 3 - Per-finger control and the gesture set ===
- Per-finger API: curl 0 to 1 per finger and per joint, spread, thumb opposition, anatomically clamped, on either hand, independently, at any time, blended over whatever pose is active.
- Counting 1 to 5 both ways (index first, and thumb first), plus any arbitrary combination from a set or mask, so "middle only" and "index and little" both work.
- Gesture set: relaxed, open palm, spread, fist with the thumb outside, point, OK, thumbs up, V, beckon, wave, finger drum, pebble roll. Gestures are data in a registry, so adding one is data, not code.
- Tests: each finger reaches its full range independently while neighbours stay inside natural coupling; every gesture is reachable, inside limits, and free of self-penetration.

=== COMMIT 4 - Grasp and manipulation ===
- Capabilities, each landing with the test or sheet that proves it: grab, hold under motion, carry, place, release, throw, catch, pad pinch, tripod, lateral pinch, hook, power cylinder grip, spherical grip, two-hand grip on one object, handover between hands, in-hand roll and spin, press a button, flip a switch, pull a lever, turn a knob, open and close a drawer, push a crate, drag a crate, hang from a rung, climb hand over hand, hold a rope.
- The grasp solver keeps working from object shape and size, and gains grip strength and slip: an object too heavy or accelerated too hard slips, with the fingers visibly losing contact.
- Weight reads in the arms: heavier objects change the IK targets and how the arm settles. No camera motion, ever.

=== COMMIT 5 - Interaction physics ===
- A small deterministic layer inside hands/, no third-party engine, fixed timestep, seeded, so replays and screenshot hashes stay stable.
- Rigid objects with mass, gravity, friction and restitution, colliding as sphere, box or capsule against the ground and each other, driven by contact impulses from the hand's phalanx capsules.
- Constraints: hinge (lever, switch, door), slider (drawer), fixed rungs, and a rope as a chain of points with distance constraints.
- Hands move objects and objects resist hands. Pushing a crate moves it, pulling a lever rotates it, climbing transfers the body anchor between hands with at least one hand attached at all times.

=== COMMIT 6 - The sandbox ===
- The sandbox is this repo's app, served at the root URL, with a scene picker: Hands (the rig alone on a plain backdrop for inspection) and Sandbox (the interaction playground).
- Sandbox props: a ledge of objects in many sizes and shapes, a button panel, a switch, a lever, a knob, a drawer, a crate to push and drag, a ball to throw and catch, a rope, and a short ladder of rungs to climb.
- Controls: an action palette grouped by capability; the capability matrix as a panel where every row is a button that plays it; per-joint sliders for all ten digits; hand picker (left, right, both); object picker and size slider; speed (0.1x, 0.25x, 1x); pause and single step; record and replay a sequence; first-person and inspection cameras; perf overlay; reduced motion.
- The controls live in a control centre that starts collapsed to one compact bar (Controls, pause, step, speed) and remembers whether it was left open and on which tab. The Controls button and the C key toggle it (Escape closes, Space pauses). Open, it docks beside the 3D view, never over it: a sheet above the bar in portrait, a column at the right in landscape and on desktop, with the view shrinking to make room, so in first person it never covers the hands or the station. Opening it changes neither the camera nor the field of view. anime.js v4 carries the open, close and tab transitions; all of them are instant under reduced motion.
- Move camera uses a direct mapping, on touch and mouse alike: drag right and the camera moves right, left moves left, up moves up, down moves down (in first person the view turns right and looks up). Settings has Invert X, Invert Y and a sensitivity slider, all defaulting to that direct mapping. The camera moves only from user input.
- Mobile first: touch drags the hand target, buttons are at least 44 px, portrait and landscape both lay out cleanly, nothing sits under the notch or the home indicator.
- Tokens: Tar #15171A panels, Lagos Yellow #F2B705 primary accent, Chalk #F1F0EB text, Zinc #8C969B secondary, Pepper #D63A26 alerts. Alfa Slab One for display, Barlow Condensed 600/800 for UI with tabular numbers. No ALL-CAPS eyebrow labels, middle-dot meta strings or arrows in button text.
- One injected clock drives everything (pause, single step, speed) with seeded randomness, plus a shot mode (URL params for scene, capability, time, camera angle, UI hidden) so any frame renders identically for screenshots.

=== COMMIT 7 - Checks, matrix, gallery, docs ===
- npm run hands:check keeps every check that came with the rig and adds: no hand to object penetration beyond 1 mm during any manipulation; a held object never leaves the grip while the grip holds and the slip threshold is not crossed; climbing always has at least one hand attached; pushed and pulled objects move only through contact; determinism hashes over a scripted 30 second sandbox run; budgets (triangles, draw calls, bones, solver ms) measured with the sandbox scene loaded.
- npm run hands:matrix prints the capability matrix: one row per capability, the check or sheet that proves it, and PASS or FAIL.
- npm run hands:gallery renders the eleven core sheets first and the full set second, at phone portrait 390x844, phone landscape 844x390 and desktop 1440x900. Frames go to artifacts/ (gitignored); commit one overview sheet per viewport to docs/assets so the PR shows them.
- README.md for the repo, unique to this library: what it is, install and run, the API table, the capability list, budgets, and the sandbox. Animated SVG of a finger curling, mermaid for the capability and state model, LaTeX for the grasp contact condition and the slip threshold, collapsible <details> for the API and limit tables, a clearly marked spot where 25TH drops a directly uploaded video. hands/README.md covers the module internals and how to add a gesture or capability. Credit both fonts as OFL-1.1.

## THE ELEVEN CORE SHEETS

1. Anatomy close-up: palm, back, side, three-quarter.
2. Counting 1 to 5 on both hands, both counting styles.
3. Gesture set: fist, open, spread, point, OK, thumbs up, V, beckon, wave.
4. Pinch and tripod on three object sizes.
5. Power and spherical grips: handle, rock, ball.
6. Two-hand grip and handover keyframes.
7. Grab, lift, carry, place: frame strip.
8. Throw and catch: frame strip.
9. Push and drag a crate: frame strip.
10. Lever, switch, knob and drawer: frame strip.
11. Climb hand over hand on rungs: frame strip.

## ACCEPTANCE

Automated (npm run hands:check and npm run hands:matrix): every check above plus everything the rig's suite already covered (joint limits, self-penetration, contacts, IK, continuity, determinism, budgets) PASS with zero FAIL, and every capability row proven by a named check or sheet.

Visual rubric, split by severity.

Blockers, which must be zero:
- An interaction that reads wrong: an object floating, a hand passing through it, a climb with no hand attached, a gesture unreadable as itself, the wrong hand acting.
- Penetration visible at sheet scale.
- A pop or teleport between frames of a strip.
- A finger bending the wrong way or past its limit.
- Framing that crops the action on phone, or anything clipping the near plane.

Minors, listed in docs/HANDS_MINORS.md with the sheet and one line each, not blocking this run:
- Mesh defects carried over from the rig's last review: ring seams at the finger joints, flat palms in the anatomy close-up, pinch frames where the free fingers splay straight.
- Any new cosmetic nit. These get fixed in a later finishing pass, not this one.

## BUDGETS

Two sets, each measured on its own subject. npm run hands:check fails if any value goes over its limit.

Hands module alone, no sandbox props (both arms with nails and sleeves), carried unchanged from the rig snapshot:
- Triangles: at most 20000 at high LOD, at most 8000 at low LOD.
- Draw calls: at most 6.
- Bones: at most 80.
- Solver time per frame: median at or under 0.5 ms, in Node.

Sandbox scene loaded (the hands, the interaction layer, the world and every station's props):
- Triangles: at most 30000.
- Draw calls: at most 45.
- Bones: at most 80.
- Solver time per frame (hands, interaction and world): median at or under 1.2 ms, in Node, over every capability scenario.

The sandbox triangle and draw-call counts are not an on-device measurement. They are read from three's renderer.info after the sandbox renders in headless Chromium on the machine running the check (WebGL through ANGLE, on the GPU where there is one, SwiftShader otherwise), taking the worst of six station shots at 844x390. The on-device figures, frame time included, come from the sandbox's perf overlay on the phone itself.

## LOOP

Each iteration: gate, hands:check, hands:matrix, hands:gallery, then review the eleven core sheets yourself, fix blockers first, commit each fix with the failing row in the message. When the core sheets carry zero blockers, do one full pass over every sheet in the gallery, then hand the eleven core sheets to a fresh subagent to review without your notes. Any blocker it finds sends you back into the loop. Before stopping each turn, print one line: what still fails and what changes next.

VERIFY: report each change, its root cause, and why it works at runtime. Where visual/interactive/environment behavior CANNOT be confirmed headlessly, SAY SO explicitly with the exact manual check to run (a green build is NOT proof for visual/runtime/prod-environment features). Gate green. At minimum list: touch control of the hand on a real phone, frame rate from the perf overlay on a mid-range phone, how grips and weight read on real screens, throw and catch timing, climb feel, reduced motion, and the sandbox in both phone orientations.

AUTO-OPEN: PORT=3100 npm start & sleep 3 && open "http://localhost:3100/"

FINISH: reviewed commits, push + open PR against main in iam25th1/25th-procedural-hands, leave open for review. Do NOT merge.
