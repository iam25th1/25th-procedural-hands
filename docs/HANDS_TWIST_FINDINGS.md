# Why the arms and thumbs looked twisted

Every automated check passed while the arms and thumbs still looked twisted by eye. The checks measured the bones, and the bones were not the problem. This page records what was measured on the rendered skin and the skeleton, the sources behind each anatomical value, what was fixed, and three fixes that conflict with existing checks. Those three are kept as patches in [`docs/conflicts/`](conflicts) and are not applied.

![Forearm skin wound in pronation, straight in supination](assets/forearm-wind.svg)

> **Media placeholder:** a screen recording of the forearm turning from full pronation to full supination, before and after, goes here.

## What was measured

All renders were made with the single arm shot scene (`/?shot=1&scene=arm&pose=relaxed&cam=palm|back|side|ulnar&pron=<deg>`), so before and after share framing and lighting.

| # | Cause | Measure | Before | Source | State |
| --- | --- | --- | --- | --- | --- |
| 1 | Forearm skin laid down unwound in full pronation | volar side against the elbow crease (bind) and the palm (supination), skinned mesh | 180 deg off at the elbow; 129, 80, 27 deg off at 28, 55, 85 percent in supination | Kulesh et al 2015 | **fixed** (e7eae3f) |
| 2 | Palm colour on the volar forearm | volar against dorsal forearm colour, every Monk tone | 6.7 dE76 | Yamaguchi et al 2004 | **fixed**: palm colour on glabrous skin only (0.07 dE76) |
| 3 | Thumb column under-rotated at rest | first metacarpal rotation, measured as Cheema et al measured it | 41.6 deg | Cheema et al 2006: 74 +/- 10 | **conflict**, patch |
| 4 | Wrist crease ring weighted against its neighbours | ring turn under 90 deg of rotation, bend under 73 deg of flexion | turn 75 against 86 either side; bend 36 against 65 | (mesh consistency) | **fixed** (88b598b) |
| 5 | Forearm skin turned in equal thirds, a third on the wrist joint | ring turn against Kulesh's per-level share | 0.56 of the hand's turn at 55 percent of the forearm (Kulesh 0.34); 0.86 at 85 percent (0.63) | Kulesh et al 2015, Tables 1 and 3; the radiocarpal joint does not pronate | **fixed**: three twist bones at the sourced shares, none on the wrist |
| 6 | Wrist thin | wrist ring perimeter | 156.6 mm against 169.0 | ANSUR II | **fixed** (8096e5d) |

### Ranking

1. **Forearm spiral (1 and 2 together).** This dominates wherever the forearm is turned away from the bind pose. That is the median sandbox pose (68 deg away) and every Hands scene pose (hands raised palms to the eye, a full 180 deg away). Cause 1 wound the skin the wrong way, and cause 2 painted the wound part with the palm's colour, so the spiral read as a stripe from wrist to elbow.
2. **Thumb (3).** It shows in every pose, since every thumb pose inherits the rest frame. The nail faced mostly dorsal (its normal 0.70 dorsal, 0.71 radial) instead of radially.
3. **Wrist band (4).** A backward twist band of 11 deg at 90 deg of rotation, 22 deg at 180.
4. **Candy wrap (5).** Linear blend skinning between twist bones 60 deg apart (a 180 deg turn) shrinks the mid forearm to 87 percent of its radius.
5. **Proportion (6).** It reads as thin, not twisted.

<details>
<summary>Forearm skin under rotation, before any fix (linear blend skinning in Node)</summary>

| Ring (fraction from the elbow) | 90 deg from bind: turn, radius | 180 deg from bind: turn, radius |
| --- | --- | --- |
| 0.28 | 25 deg, 98.2 % | 51 deg, 93.0 % |
| 0.55 | 50 deg, 96.9 % | 100 deg, 87.9 % |
| 0.85 | 77 deg, 96.6 % | 153 deg, 86.7 % |
| 0.95 | 86 deg, 98.4 % | 173 deg, 93.8 % |
| wrist crease | 75 deg, 96.6 % | 150 deg, 86.6 % |
| palm, 12 mm past | 86 deg, 98.3 % | 172 deg, 93.4 % |

</details>

The winding: each forearm ring is laid down turned back by the share of the half turn it does not carry,

$$\alpha(f) = (1 - s(f))\,\pi, \qquad s(f) = \frac{\sum_i w_i(f)\,\tau_i}{\sum_i w_i(f)}$$

where $w_i$ are the ring's skin weights and $\tau_i$ each bone's share of the forearm's rotation (0 for the elbow and upper arm, 1/3, 2/3 and 1 along the twist chain).

## Renders, before and after

Each image has the before row on top and the after row below, with the same framing and lighting.

| Change | Views | Image |
| --- | --- | --- |
| Recon: the thumb at rest (palmar, dorsal, radial, ulnar) | four views, before any change | ![](assets/twist/recon-thumb-rest.png) |
| Recon: the forearm at 90, 0 and -90 deg | before any change | ![](assets/twist/recon-pronation.png) |
| Wrist weights (88b598b) | thumb up; full supination from above and below | ![](assets/twist/wrist.png) |
| Forearm winding (e7eae3f) | bind from above and below; thumb up; full supination | ![](assets/twist/forearm.png) |
| Wrist girth (8096e5d) | bind; thumb up from the side; full supination | ![](assets/twist/girth.png) |
| Pronation on three twist bones in Kulesh's shares (landed) | back at 90, 0 and -90 deg; palm and side at -90 | ![](assets/twist/pronation.png) |
| Thumb roll (patch, not applied) | palm, back, radial, ulnar, three quarter | ![](assets/twist/thumb.png) |
| Glabrous colour (landed) | bind from above and below; thumb up; full supination | ![](assets/twist/colour.png) |
| Gallery: counting, desktop | the core sheet before and after the three commits | ![](assets/twist/gallery-counting.png) |

## Sources

- Cheema TA, Cheema NI, Tayyab R, Firoozbakhsh K. Measurement of rotation of the first metacarpal during opposition using computed tomography. *J Hand Surg Am* 2006;31(1):76-79. doi:10.1016/j.jhsa.2005.08.016. They measured the angle between the dorsal tangent of the 2nd and 3rd metacarpals and the line through the first metacarpal head at the sesamoids. It is 54 +/- 10 deg in retroposition, 74 +/- 10 at rest, and 100 to 110 in opposition.
- Cooney WP, Lucca MJ, Chao EY, Linscheid RL. The kinesiology of the thumb trapeziometacarpal joint. *J Bone Joint Surg Am* 1981;63(9):1371-1381. The trapezium sits at 48 deg flexion, 38 deg abduction and 80 deg pronation to the third metacarpal. It is supporting context only: the rig's thumb direction (24 to 32 deg palmar out of the palm plane) has no source and was not changed.
- Kulesh PN, Fletcher MDA, Solomin LN. Avoidance of external fixation pin induced rotational stiffness in the forearm. *SICOT J* 2015;1:3. doi:10.1051/sicotj/2015005. Cadaver skin displacement at 70 deg of rotation: least against the ulna near the elbow, and least against the radius in the distal third (40 to 88 mm proximally, 7 to 23 mm distally).
- Yamaguchi Y et al. Mesenchymal-epithelial interactions in the skin. *J Cell Biol* 2004;165(2):275-285. doi:10.1083/jcb.200311122. Melanocyte density in palmoplantar skin is a fifth of other sites'.
- ANSUR II (2012), combined sample, N = 6068, means computed from the public data file:

  | Measure | Mean (mm) | SD |
  | --- | --- | --- |
  | Wrist circumference | 169.0 | 13.1 |
  | Forearm circumference, flexed | 295.0 | 30.0 |
  | Radiale to stylion | 259.2 | 19.8 |
  | Acromion to radiale | 327.4 | 20.7 |
  | Stature | 1714.4 | |

## The conflicts

Each patch applies to the committed tree with `git apply docs/conflicts/<name>.patch`. Each carries its fix and the check that would have caught the cause, and each fails existing checks as listed. Per the rule for this work, no existing check was loosened, deleted or re-baselined to make room for them.

```mermaid
flowchart TD
  T["thumb-rest-roll.patch: roll -24.2 deg, pre-shape abduction 37"] -->|fails| T1["Hook, Pull a lever, Drag a crate, Handover + 4 aggregates"]
```

### thumb-rest-roll.patch

This rolls the thumb column -24.2 deg about its own axis, so the relaxed pose measures 74.1 deg by Cheema's method (was 41.6). It also sets the power-grip pre-shape's CMC abduction to 37, the joint's limit; it was authored at 40, past the limit. The new check, `anatomy: first metacarpal rotation at rest`, fails the current rig and passes with the patch.

It fails 8 existing checks: Hook (16.8 mm into the strap), Pull a lever (23.7 mm), Drag a crate (26.3 mm), and Handover (a floating handle), plus the four aggregates over them. The cause was traced for Drag a crate. The rolled thumb no longer blocks a grip pose the reach planner used to reject. The planner now picks that pose, the flat approaching fingers graze the handle's top, and the physics shoves the crate up 18 mm. The live wrist lands exactly on the planned pose, so this is planner behaviour exposed by the correct thumb, not a thumb error. Fixing it means changing how the reach planner scores hook approaches: out of scope for this pass, and reported rather than tuned.

The visible effect alone is modest. The pad turns toward the fingers and the nail faces radially. The column's direction out of the palm is unchanged, because it has no source.

### Landed: pronation on three twist bones, in Kulesh's shares

The held patch put pronation on two twist bones, half each, and required the distal third of the forearm to turn at least 90 percent with the hand. Reading Kulesh's tables in full contradicted that. Skin displacement against the ulna and against the radius at each of the eight levels gives the skin's share of the hand's turn, $\bar d_u/(\bar d_u+\bar d_r)$: 0.063 at the radial neck rising to 0.728 at the distal radius. So the distal forearm does not turn with the hand, and the equal thirds turned the skin too early rather than too late (0.56 at 55 percent of the forearm against 0.34). The recon's claim that the distal third should turn with the hand was wrong.

What landed instead: three twist bones at 0.5625 (share 0.346), 0.9375 (0.728) and the distal radius (1), and the wrist joint's pronation at 0. Every ring turns within 0.021 of Kulesh's share. Candy wrap improved rather than worsened: the narrowest section of the rendered surface at 180 deg keeps 83.1 percent of its radius, against 79.2 under equal thirds. (The recon's 87 and 74 percent were ring vertices only; the facets between rings narrow further.) Dual quaternion skinning was not needed and was not chosen. It would remove the blend narrowing but not the facet narrowing between rings, and it would replace three.js's skinning shader for every bone of the hand.

Hang from a rung (the thumb metacarpal 14.1 mm into the rung under the patch) passes. The patch's ±45 deg per-bone limits changed which arm poses the reach planner judged roomy (it scores room on `forearm-twist-1`'s range). With each bone limited to its own part of the ±90 deg range, the chosen poses and the hand's orientation are the same as before, since the twist bones turn about one axis and their sum is unchanged.

### Landed: palm colour on glabrous skin only

The palm's lighter colour now stays on glabrous skin: the palm and the volar digits, stopping at the wrist crease. The volar forearm keeps the forearm's colour, which removes the stripe that made the forearm spiral visible in every rotation. `colour: the palm colour stops at the wrist crease` measured 6.7 dE76 before and 0.07 after.

The unit test `colorize: on every Monk tone the palm is lighter than the back` counted every palmar-facing skin vertex as "palm", the volar forearm included, so it encoded the defect. It now counts glabrous skin only, with every assertion kept; the old and new assertion are in [the spec](HANDS_SANDBOX_SPEC.md#anatomical-values-and-corrected-checks).

It also explains the rendered skin-tone drift. The winding commit (e7eae3f) turned the palm-coloured volar forearm into the edge of the back view the skin-tone check samples, so deep tones' backs rendered lighter (Monk 10 back L* 14.6 to 16.6; worst dE76 1.20 to 2.43). With the forearm coloured as forearm the worst is back to 1.4.

## Checks added

| Check | Committed | Would have caught |
| --- | --- | --- |
| skinning: forearm and wrist skin turn and bend toward the hand in order | yes | the wrist crease ring turning 12.1 percent and bending 38.4 percent less than the ring before it |
| skinning: forearm skin wound as the forearm is | yes | the forearm's volar side 180 deg off the elbow crease at bind, and spiralled in supination |
| proportion: forearm length and wrist girth within half an SD of ANSUR II | yes | the wrist at 156.6 mm against 169.0 |
| anatomy: first metacarpal rotation at rest (Cheema 2006) | in thumb-rest-roll.patch | the thumb at 41.6 deg against 74 +/- 10 |
| skinning: the distal third of the forearm turns with the hand | in pronation-split.patch | a third of pronation at the wrist joint (85 percent at 85 percent of the forearm) |
| colour: the palm colour stops at the wrist crease | yes | the palm colour painted up the volar forearm (6.7 dE76) |
