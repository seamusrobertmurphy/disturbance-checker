# Interpreting results

The tool detects spectral change rather than disturbance itself, and this guide
covers the evidence that separates the two.

## What each index measures

**dNDVI** is the change in vegetation greenness. It falls when canopy is
removed, so a positive dNDVI indicates canopy loss between the pre and post
windows, and it serves as the primary canopy-loss signal.

**dNDMI** is the change in vegetation water content, using the shortwave
infrared band. It responds to moisture stress before greenness drops, which
makes it the earliest indicator of drought, beetle attack and pathogens, and
also the index most sensitive to seasonal timing.

**dNBR** is the change in the burn index, the standard fire severity measure
used by MTBS and the USFS. Here it serves mainly as a control, showing whether
canopy loss coincides with fire.

All three are differenced so that **positive means change of interest**, which
is worth keeping in mind because dNBR is computed post minus pre while the other
two are pre minus post.

## The four classes

The classes are undisturbed, Low, Moderate and High. Undisturbed pixels are
transparent, so every visible cell on the classified layer is at or above the
Low threshold.

Coloured cells are best treated as candidates for review rather than as
findings in their own right.

## Read the histogram before the map

Reading the histogram first is the most useful habit in this workflow, and a
past finding was revised because this step was skipped. The histogram shows how
many pixels fall at each value of the difference, and its shape indicates how
much weight the coloured cells on the map can carry.

**Unimodal, centred on zero, narrow tail.** Most pixels barely changed and the
tail falls away quickly, which describes a clean result with no disturbance. The
defaults hold, and any isolated cells that remain are worth a look although the
site is substantially undisturbed.

**Bimodal, with a clear gap.** A large peak at zero is followed by a gap and a
second, smaller population further right, which is the signature of real
disturbance, a set of pixels behaving quite differently from the rest. Placing
the Low threshold inside the gap usually serves better than the default, and the
tool marks the suggested position with a dashed green line.

**Unimodal with a long right tail and no gap.** The peak sits at zero but the
distribution carries weight far to the right with nothing separating signal from
noise. **This shape points to composites that are not comparable rather than to
disturbance**, and the usual causes are cloud shadow, seasonal timing or
viewing-angle effects. The tool raises a warning and reports the percentage of
the area being flagged.

![Blackfeet dNDMI distribution from an October to December composite: unimodal, right-skewed, with no gap between the noise bulk near zero and the tail](images/figA1-histogram.webp)

*This shape calls for caution. The default 0.05 break, marked in yellow, sits on
the shoulder of the noise bulk rather than beyond it, which is why 38% of the
area came back flagged. The red lines show where the breaks were moved to.*

With this shape, the input is generally a better place to intervene than the
thresholds, since raising thresholds until the map looks sensible hides the
underlying mismatch. The first things to check are that both windows fall in the
growing season and cover the same months, and a tighter clear-pixel threshold is
also worth considering.

**Peak not centred on zero.** A shift of the whole distribution indicates a
systematic offset between the two composites rather than localised change.

## The worked example behind the warnings

A first-pass check once flagged about 38% of a project area as moisture-stressed
under the default thresholds. The pattern was diffuse, with no relationship to
stand age, aspect or known beetle pressure, which was the first indication that
something other than disturbance was at work.

The histogram was unimodal with a long right tail and no gap. The cause was the
reporting calendar, since both composites had been drawn from October to
December windows. In that season senescence drives shortwave infrared
reflectance up before leaf-fall, producing a uniform false moisture-stress
signal across the whole site, and the default Low threshold, sitting on the
shoulder of the noise bulk, reclassified ordinary autumn phenology as
disturbance.

Re-running with July to September windows reduced the flagged area from 38% to
4%, all of it co-located with reported beetle survey polygons.

This case is the reason the tool warns about dormant-season windows, and why a
unimodal histogram with a long tail is best met by auditing the dates before
adjusting the thresholds.

## Cross-checking the three layers

Read together, the three layers point to the likely cause.

**dNDVI high, dNBR clean.** Canopy was lost without fire, which suggests
harvest, blowdown, clearing or a landslide, and the shape of the polygon is the
next thing to examine.

**dNDVI high, dNBR also high.** This indicates fire. Confirming it against the
official MTBS or NIFC perimeter before raising anything is advisable, because
the developer will refer to that perimeter.

**dNDMI high, dNDVI and dNBR clean.** This indicates moisture stress without
canopy loss so far, from drought, insects or disease. Corroboration from a
drought monitor or a beetle survey strengthens the case considerably, because on
its own this is the weakest signal and the most likely to be a timing artefact.

![dNBR over the same area, showing scattered low and moderate burn-severity pixels that do not coincide with the moisture-stress signal](images/figA3-dnbr-crosscheck.webp)

*Cape Fox, RP2. The dNBR pixels are scattered and spatially uncorrelated with
the dNDMI signal, which is the pattern that rules out fire. The finding that
followed was yellow-cedar decline rather than burn.*

## Read the edges

For a genuine canopy-loss polygon, the shape of its edges helps distinguish
human from natural causes.

**Straight edges, right angles, linear corridors.** These are typically
anthropogenic, such as harvest units, roads and rights of way. A long thin
polygon with right-angled terminations is very often a road or utility
clearance.

**Curvilinear or amorphous edges.** These are typically natural, such as
blowdown, decline and slides.

**An edge following the project boundary or a plot line.** These merit close
attention, since they often reflect harvest arriving from a neighbouring
property, and whether the loss falls inside or outside the boundary is the
question at issue.

![dNDVI canopy loss in red at a plot boundary, with straight edges following plot lines and an external cutblock perimeter](images/figA4-dndvi-edges.webp)

*Linear edges with right-angled terminations following plot lines and an
external cutblock perimeter, consistent with road or right-of-way clearance
rather than a natural event.*

![Closer view showing the canopy-loss footprint running from the plot interior toward the project boundary](images/figA5-plot-1165.webp)

*The same polygon closer in. The footprint runs from the plot interior toward
the project boundary, consistent with removal originating from neighbouring
cutblocks. This became a CAR asking the developer to confirm whether timber
removal occurred on site and how it was treated in the HWP accounting.*

Loading and labelling plot points is worthwhile for this reason, since it allows
the plot to be named in the screenshot rather than described in prose.

## Areas

The class-area table reports hectares per class, computed on a metric projection
rather than on latitude and longitude, which would understate area at high
latitudes.

The totals are best treated as indicative. They are computed at 20 metre
resolution, so fragmented disturbance with a lot of edge is somewhat
under-counted relative to a 10 metre export, and the share-of-area percentage is
the more robust figure for a finding.

## Before you raise anything

1. The histogram shape supports the thresholds used.
2. No warning in the panel remains unresolved.
3. dNDVI has been cross-checked against dNBR.
4. The before-and-after true-colour composites over the polygon have been
   reviewed, using the Pre RGB and Post RGB layers. Standing canopy in the pre
   image and bare ground in the post image is direct evidence, and it is the
   evidence a developer tends to find most persuasive.
5. The screenshot includes both the classified layer and the cross-check layer,
   since auditors and developers expect to see the cross-check alongside the
   layer that raised the question.
6. The run manifest is at hand.

## When the check comes back clean

A clean result does not by itself close the audit. A project reporting zero
harvest may still need to demonstrate that harvesting has not moved to land
elsewhere under the same ownership. The same check can be pointed at those
external holdings by setting the area of interest to them, and canopy loss
emerging there belongs in the leakage documentation rather than the project
disturbance ledger.
