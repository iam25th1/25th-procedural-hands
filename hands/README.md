# hands: module internals

The procedural hand and arm library that lives in `hands/src`. It imports nothing but `three` (only `three-view.js` does, for rendering) and never touches the DOM, so every line runs under `node --test`. The repository README covers what the library is for and how to run the sandbox; this file covers how it works inside and how to extend it.

Units are metres, kilograms and seconds. Angles are radians in code and degrees in data tables.

## Files

| File | What it owns |
| --- | --- |
| `index.js` | The public API: `create()` returns a `Hands` instance; re-exports the building blocks |
| `rig.js` | `Rig`: skeleton plus solvers, pose layers, per-finger control, springs, IK per step, controllers |
| `skeleton.js` | 30 joints per side: shoulder, upper arm, forearm, two twist bones, the 25 WebXR hand joints |
| `anatomy.js` | Every length, limit and coupling ratio, each with its source |
| `fingers.js` | Pose to channel resolution, natural coupling, per-finger curl and spread mapping |
| `poses.js` | Named hand poses as per joint data in degrees |
| `grasp.js` | Grip taxonomy, pre-shape, closure to contact, object placement and attachment |
| `ik.js` | Two bone arm IK with a pole, reach clamping, pronation shared in thirds |
| `springs.js` | Critically damped springs and the under damped oscillator |
| `mesh.js` | Lofted skinned arm and hand mesh, skin weights, vertex colour |
| `three-view.js` | `createThreeView`: one `SkinnedMesh` per arm for a three.js scene |
| `gestures.js` | The gesture registry (data) and the interpreter that plays an entry |
| `selfcontact.js` | Thumb and neighbouring finger guards that keep transitions from passing digits through each other |
| `measure.js` | Limit margins, self-penetration and object penetration, shared by tests and checks |
| `stones.js` | Procedural pebbles, rocks and the sachet |
| `clock.js`, `rng.js`, `math.js` | Fixed step clock, seeded generator, dependency free vector and quaternion math |
| `defaults.js` | Skin tones, sleeve colours and object presets, all overridable |

## One step

```mermaid
flowchart LR
  U[update dt] --> S[fixed 60 Hz step]
  S --> C[controllers: update]
  C --> A[arm target springs, follow targets]
  A --> I[two bone IK per arm]
  I --> H[hand channel targets: base pose, blend layers, gesture, per-finger control, sliders]
  H --> K[critically damped spring per channel]
  K --> F[forward kinematics]
  F --> P[controllers: post]
```

Every animated channel goes through a critically damped spring, stepped with its exact closed form so the result is repeatable bit for bit:

$$\ddot x = -\omega^2 (x - x_t) - 2\omega\,\dot x$$

## Per-finger control

`setFinger(hand, finger, curl, spread)` and `setFingerJoint(hand, finger, joint, curl)` put a digit under direct control. Curl 0 to 1 maps onto each joint's flexion range from `anatomy.js`, spread -1 to 1 onto MCP abduction. The control blends in over whatever pose is active through its own spring weight, so a finger can be driven while a gesture plays on the rest of the hand. Fingers that are not under control follow a controlled neighbour by the enslaving fractions in `COUPLING.enslave`, which is what keeps a curled ring finger from leaving the little finger perfectly straight. `releaseFingers` hands the digit back to the pose.

<details>
<summary>Joint mapping</summary>

| Digit | Joint | curl 0 | curl 1 |
| --- | --- | --- | --- |
| index to little | MCP | 0 deg | 90 deg |
| index to little | PIP | 0 deg | 100 deg |
| index to little | DIP | follows PIP at 2/3, or 0 to 90 deg when set | |
| thumb | CMC | sweep -12 deg, palmar abduction -12 deg | sweep 48 deg, palmar abduction 10 deg |
| thumb | MCP | 0 deg | 60 deg |
| thumb | IP | 0 deg | 88 deg |

</details>

## Counting and finger sets

`count(hand, n, style)` shows 1 to 5 counted from the index (`'index'`) or from the thumb (`'thumb'`). `showFingers(hand, set)` extends any combination of digits, so "middle only" is `showFingers('right', ['middle'])` and "index and little" is `showFingers('left', ['index', 'little'])`. Both generate a pose from the set (`fingerSetPose` in `poses.js`): extended fingers straight with a natural spread and held straight on purpose (active extension keeps only 30 percent of the enslaving pull from a folded neighbour), folded fingers curled as in a fist, and a folded thumb rested on the nearest run of folded fingers by the same coordinate descent the fist uses. Every one of the 32 combinations is checked by `npm run hands:check`.

## Gestures are data

`GESTURES` in `gestures.js` holds every gesture as a plain entry. A static gesture is only a pose name. A moving one adds any of: `arm` (where the hand goes, mirrored for the left hand), `armOsc` (a wrist oscillation about a body space axis), `osc` (finger oscillations: which digits, which joints, amplitude in degrees, rate, phase step between digits and a waveform), and `object` plus `grip` (something held first, as in the pebble roll). `compileGesture` turns an entry into the rig's gesture spec; nothing else knows which gestures exist.

<details>
<summary>How to add a gesture</summary>

1. Static: if the hand shape is a combination of straight and folded digits, use a finger set as the pose: `{ pose: 'set:index+little' }`. Otherwise add a `hand(...)` entry to `POSES` in `poses.js` (degrees per joint; `dip` left out follows the PIP) and name it as the entry's `pose`.
2. Moving: add `arm`, `armOsc` or `osc` fields. The drum entry is a good model: `{ digits: ['little', 'ring', 'middle', 'index'], joints: { mcp: -30, pip: -15, dip: -10 }, hz: 2.8, phaseStep: -0.25, wave: 'tap' }` lifts each finger in turn.
3. Register it: add it to `GESTURES`, or call `registerGesture(name, entry)` at runtime.
4. The `gestures:` check in `npm run hands:check` samples every registry entry at 60 fps on both hands for reach, limits, self-penetration and continuity, so a new gesture is covered the moment it exists. Add a shot for it in `scripts/gallery/shots.js` to see it on a sheet.

</details>

## Self contact

Named poses and finger sets are solved clear of each other, but the straight path between two poses in joint space can carry the thumb through a finger (a relaxed hand closing into a fist sweeps the thumb across the index), and spreading a finger toward a straight neighbour would pass through it. After the springs move the hand each step, `guardFingers` stops neighbouring fingers where their sides meet and `guardThumb` runs a short coordinate descent on the thumb's own channels that moves it the least it can to slide over the digit in its way. The springs carry on from the corrected state, so the thumb reaches the pose around the fingers rather than through them.

## Isolation

`test/isolation.test.js` (run by `npm test` in the gate) and the `isolation:` row of `npm run hands:check` lex every file under `hands/src`, strip comments and string bodies, and fail if an import resolves outside `hands/`, names any package but `three`, is a computed dynamic import, or if `window` or `document` appears in code.
