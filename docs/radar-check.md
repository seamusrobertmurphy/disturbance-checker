# Radar canopy loss

Version 0.14.0 added a second sensor to the check. The switch at the top of
section 1 moves the run from Sentinel-2 light to Sentinel-1 radar, and the run
then produces one layer, dVH, in place of the three optical ones. This guide
says what that layer measures, how it is built, how its thresholds were set and
tested, and what to confirm before a radar patch is reported.

The order is why radar, then the method step by step, then the thresholds and
their test, then what the tool changes from the notebook it reproduces, then
the references.

## Why radar

The optical check needs a clear look at the ground in both windows. A project
harvested in winter on frozen ground, under cloud and snow, gives it none, and
the first clear summer window after the cut shows regrowth, slash and bare
ground all at once. Radar sends its own signal and measures how much comes
back, so it sees through cloud and darkness and is not hidden by snow.

The VH channel, sent vertically and received horizontally, comes back mostly
from branches and stems, which turn the signal between the two directions. When
a stand is cut that volume is gone and the VH return falls. The drop is what the
layer maps, in decibels, with a positive value meaning loss, as in the other
layers.

## The method

The run reproduces the Radar canopy loss cell of the ArcGIS Pro notebook,
`TUVSUD_Anew_Claybelt_RP1_DisturbanceCheck_ArcGIS.ipynb`, step for step.

1. Every Sentinel-1 scene over the boundary in each window is found. The
   windows are the ones set in section 3, shared with the optical check.
2. Only the relative orbits imaged in both windows are kept. Backscatter
   depends on the direction the satellite looked from and the angle it looked
   at, which a relative orbit fixes, so every pixel is compared with itself seen
   from the same side. An orbit present in one window and missing from the
   other would put that change of geometry into the drop and have it read as
   loss. The orbits used and the scene counts are printed with the result.
3. Each window is the per-pixel median of its scenes, in decibels. The median
   rather than the mean, so one scene with wet snow or a melt does not pull the
   whole window.
4. A 25 m mean quiets the speckle that every radar image carries.
5. The earlier window less the later is the drop.
6. The median of that drop over the whole boundary is subtracted from every
   pixel, so a change affecting the whole scene, such as a colder or wetter
   winter or the switch from Sentinel-1A to Sentinel-1C in 2025, is not read as
   loss. The amount removed is printed with the result.
7. Water is removed, and the drop is classified at the thresholds below.

Earth Engine, which the notebook reads, applies the orbit file, border and
thermal noise removal, radiometric calibration, terrain correction and the
conversion to decibels [1], and ESA multilooks the product, five looks by one
on 10 m pixels [2]. The 25 m mean follows the SNAP chain in [3].

## Frozen ground

Both windows should sit in the same part of winter, after freeze-up and before
thaw, 5 December to 4 February either side of the period for example, so that
frozen ground is compared with frozen ground. Wet snow, melt and thaw move VH
by more than a thinning does, and a window that straddles a thaw in one year
and not the other reads as change across the whole boundary. The season charts
under the reporting periods show the daily temperature, so a window can be
placed below freezing in both years.

## Thresholds and their test

The breaks grade the VH drop as in the table. They were set by hand as steps of
the drop in decibels, not taken from a published source, and tested near
Cochrane, Ontario, 48.5 to 50.0 degrees north and 79.5 to 82.5 degrees west,
against the clearcuts that Ontario's forest management annual reports record
[8] for the year from 1 April 2024 to 31 March 2025, 878 blocks covering
8,455 ha, comparing 15 December 2023 to 15 March 2024 with 15 December 2025 to
15 March 2026. The table gives the share of 1,491 points inside those clearcuts,
and of 2,837 points more than 50 m from any harvest reported since 2015, that
reached each break. The second group is ground that includes bog, fen and open
land and any fire, blowdown or unreported cutting.

| Class | VH drop | Clearcut points at or above | Unharvested points at or above |
|---|---|---|---|
| Low | 2.0 to 2.5 dB | 43.9% | 3.8% |
| Moderate | 2.5 to 3.5 dB | 28.1% | 1.9% |
| High | 3.5 dB and above | 9.1% | 0.5% |

A Low break of 1.5 dB would have reached 59.2 per cent of the clearcut points
and 8.1 per cent of the unharvested points, and 2.0 dB was chosen to flag less
unharvested ground. Radar therefore misses more than half of the clearcut
pixels at the Low break and flags some unharvested ground, so a dVH patch is
checked against the before and after views, the optical layers and the
corroboration layers before it is reported. The test is
`TUVSUD_Calibration_RadarBreaks_Cochrane.py` beside the notebook.

Published clear-cut drops sit close to these breaks, with thresholds of 2.0,
2.5 and 3.0 dB tested in Swedish boreal forest [4], a VH drop of 2.5 to 3.1 dB
for full canopy loss in temperate forest [5], an average of 2 dB for
clearcutting reported by Olesk et al. (2015) and cited in [5], a decline of at
least 2 dB in 77.8 per cent of clear-cuts on frozen ground in Latvia [6], and a
3 dB threshold for tropical deforestation [7]. Low and Moderate fall within
that range and High lies above it. The published figures are drops before any
correction, whereas these breaks apply after the shift of the whole boundary is
removed, which is why the tool always removes it and offers no switch.

## What the browser changes

Two steps differ from the notebook, and the run prints both as warnings.

The imagery is Microsoft Planetary Computer's radiometrically terrain corrected
product rather than Earth Engine's GRD collection. Both are terrain corrected,
that is placed on the map correctly; the Planetary Computer product is also
terrain flattened, so the brightening of a slope that faces the satellite is
taken out. The notebook records that Earth Engine does not flatten terrain and
that slope still changes backscatter on steep ground, so this is closer to the
canopy. The breaks were calibrated on the unflattened product. The flattening
is a correction per pixel that depends on the terrain and the orbit geometry,
both the same in the two windows once the orbits are matched, so it largely
cancels in the subtraction and the breaks are carried over unchanged. That
carry-over has not been tested on steep ground.

Water is removed where VH falls below -22 dB in either window rather than from
the JRC Global Surface Water layer, which has no copy a browser can read on the
working grid. Open water scatters almost nothing back, so it sits far below any
forest; bare rock and tarmac go with it, which is no loss to a canopy check.

The scenes are read at 20 m, the shared working grid, so the 25 m mean is the
eight neighbours of each pixel and itself.

## References

1. Google Earth Engine. Sentinel-1 algorithms.
   [developers.google.com/earth-engine/guides/sentinel1](https://developers.google.com/earth-engine/guides/sentinel1)
2. ESA SentiWiki. Sentinel-1 products.
   [sentiwiki.copernicus.eu/web/s1-products](https://sentiwiki.copernicus.eu/web/s1-products)
3. Murphy, S. Mapping flood dynamics, SAR processing.
   [github.com/seamusrobertmurphy/mapping-flood-dynamics](https://github.com/seamusrobertmurphy/mapping-flood-dynamics)
4. Santoro, M., Fransson, J.E.S., Eriksson, L.E.B. and Ulander, L.M.H. (2010).
   Clear-cut detection in Swedish boreal forest using multi-temporal ALOS PALSAR
   backscatter data. IEEE Journal of Selected Topics in Applied Earth
   Observations and Remote Sensing 3(4), 618-631.
   [doi.org/10.1109/JSTARS.2010.2048201](https://doi.org/10.1109/JSTARS.2010.2048201)
5. van der Woude, S., Reiche, J., Sterck, F., Nabuurs, G.-J., Vos, M. and
   Herold, M. (2024). Sensitivity of Sentinel-1 backscatter to management-related
   disturbances in temperate forests. Remote Sensing 16(9), 1553.
   [doi.org/10.3390/rs16091553](https://doi.org/10.3390/rs16091553)
6. Cimdiņš, R. (2018). Forest management control potential using Sentinel-1.
   Bachelor thesis review, University of Latvia, not peer reviewed.
   [clge.eu PDF](https://www.clge.eu/wp-content/uploads/2019/04/EGNSS_Cimdins_LV_Sentinel-for-forest.pdf)
7. Bouvet, A., Mermoz, S., Ballère, M., Koleck, T. and Le Toan, T. (2018). Use
   of the SAR shadowing effect for deforestation detection with Sentinel-1 time
   series. Remote Sensing 10(8), 1250.
   [doi.org/10.3390/rs10081250](https://doi.org/10.3390/rs10081250)
8. Ontario Ministry of Natural Resources. Ontario Forest Historical Annual
   Report Data, May 2026, used to test the breaks.
   [geohub.lio.gov.on.ca](https://geohub.lio.gov.on.ca/documents/a2746970ec744ed38acdd9bfc45cdeb8)
9. Microsoft Planetary Computer. Sentinel-1 Radiometrically Terrain Corrected.
   [planetarycomputer.microsoft.com/dataset/sentinel-1-rtc](https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc)

See also [Matching the season](season-matching.md) for the optical windows and
[Interpreting results](interpreting-results.md) for the histogram.
