# =============================================================================
#  TUV SUD | Green Energy & Sustainability Division
#  Canopy Disturbance Check: S2 Change Detection
#  ArcGIS Pro Python-window port of the QGIS/geemap original
# =============================================================================
#
#  Outputs
#    dNDVI  - Canopy loss     (harvest, blowdown, deforestation)
#    dNDMI  - Moisture stress (pest, drought, beetle damage)
#    dNBR   - Burn severity   (wildfire, prescribed burn)
#
#  Spectral equations
#    NDVI = (B8  - B4)  / (B8  + B4)    NIR vs Red    vegetation vigour
#    NDMI = (B8  - B11) / (B8  + B11)   NIR vs SWIR1   canopy moisture
#    NBR  = (B8A - B12) / (B8A + B12)   nrNIR vs SWIR2 fire / char signal
#
#  Change trends
#    dNDVI = pre - post   positive = canopy loss
#    dNDMI = pre - post   positive = moisture loss / stress
#    dNBR  = post - pre   positive = burned area (MTBS convention)
#
#  Temporal windows
#    Oct-Dec composites capture dormant/senescent canopy which inflates dNDMI.
#    Preferred window for moisture-stress detection: July-August (peak growth).
#    Adjust RP_START / RP_END below before running.
#
# -----------------------------------------------------------------------------
# Step I: Environment setup (ArcGIS Pro) -- SELF-INSTALLING
# -----------------------------------------------------------------------------

import os
import sys
import subprocess

EE_PROJECT = "murphys-deforisk"   # <-- your Earth Engine Cloud project id


import zipfile
import urllib.request

import ee
import numpy as np
import matplotlib
matplotlib.use("Agg")           # no interactive backend in the Pro Python window
import matplotlib.pyplot as plt

import arcpy

init_earth_engine(EE_PROJECT)

# -----------------------------------------------------------------------------
# Step III: ArcGIS output locations and the active map
# -----------------------------------------------------------------------------
#  All EE results land here as GeoTIFFs, then get added to the active map.
#  Edit OUTPUT_DIR to taste; it is created if missing.

OUTPUT_DIR = os.path.join(arcpy.env.scratchFolder, "ClaybeltDisturbance")
os.makedirs(OUTPUT_DIR, exist_ok=True)
arcpy.env.overwriteOutput = True

# Grab the active map from the current Pro project. When run outside Pro
# (standalone testing), aprx will fail; the download helper still works so you
# can inspect the GeoTIFFs directly.
try:
    _aprx = arcpy.mp.ArcGISProject("CURRENT")
    _active_map = _aprx.activeMap
    if _active_map is None and len(_aprx.listMaps()) > 0:
        _active_map = _aprx.listMaps()[0]
except Exception as exc:          # noqa: BLE001
    _aprx, _active_map = None, None
    print("Not running inside ArcGIS Pro (no active map): {}".format(exc))


# -----------------------------------------------------------------------------
# Step IV: Spatial & temporal filters
# -----------------------------------------------------------------------------
#  Project area WGS84 bounding box. Corners (lat, lon):
#    NW 49.06824,-81.79362   SW 48.68688,-81.74027
#    SE 48.67742,-81.19107   NE 49.08762,-81.19634
roi = ee.Geometry.Rectangle([-81.79362, 48.68688, -81.19107, 49.08762])

# RECOMMENDED: switch to July-Aug for growing-season moisture-stress detection.
# Watch for dormant-season senescence that inflates dNDMI extent.
RP_START_BEGIN = "2023-11-01"
RP_START_END   = "2024-02-01"
RP_END_BEGIN   = "2025-11-01"
RP_END_END     = "2026-02-01"

# Cloud filter (% cloudy pixels per scene) used by the legacy QA60 path.
MAX_CLOUD = 10

# Download resolution for the arcpy front end. 20 m keeps getDownloadURL under
# its request-size ceiling for this ROI; drop to 10 for finer output but expect
# the toDrive export path (Step X) to be needed if the request is rejected.
DOWNLOAD_SCALE = 20
EXPORT_CRS = "EPSG:4326"

# -----------------------------------------------------------------------------
# Cloud Score+ setup (better cloud removal)
# -----------------------------------------------------------------------------
cs_plus = ee.ImageCollection("GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED")
QA_BAND = "cs"
CLEAR_THRESHOLD = 0.40          # 0.50-0.65 stricter, fewer pixels


def build_composite(start, end, roi_geom):
    """Build a cloud-optimized composite using Cloud Score+ instead of QA60."""
    s2 = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
          .filterDate(start, end)
          .filterBounds(roi_geom))

    # Link Cloud Score+ collection
    s2_linked = s2.linkCollection(cs_plus, [QA_BAND])

    # Mask clouds using Cloud Score+
    masked = s2_linked.map(
        lambda img: img.updateMask(img.select(QA_BAND).gte(CLEAR_THRESHOLD)))

    # Quality mosaic (best pixels instead of median)
    composite = (masked
                 .qualityMosaic(QA_BAND)
                 .divide(10000)   # keep reflectance scaling
                 .clip(roi_geom))
    return composite


def mask_s2_clouds(image):
    """Legacy QA60 cloud/cirrus bitmask + DN->reflectance scaling.
    Retained for reference; build_composite (Cloud Score+) is the default."""
    qa = image.select("QA60")
    cloud_bit_mask = 1 << 10
    cirrus_bit_mask = 1 << 11
    mask = (qa.bitwiseAnd(cloud_bit_mask).eq(0)
            .And(qa.bitwiseAnd(cirrus_bit_mask).eq(0)))
    return (image.updateMask(mask)
            .divide(10000)
            .copyProperties(image, ["system:time_start"]))


pre_composite = build_composite(RP_START_BEGIN, RP_START_END, roi)
post_composite = build_composite(RP_END_BEGIN, RP_END_END, roi)


# -----------------------------------------------------------------------------
# Step V: Water masking
# -----------------------------------------------------------------------------
#  Mask pixels with >= 50% water occurrence to exclude lakes, rivers, wetlands.
water_mask = (ee.Image("JRC/GSW1_4/GlobalSurfaceWater")
              .select("occurrence")
              .lt(50)
              .unmask(1))


# -----------------------------------------------------------------------------
# Step VI: Spectral indices
# -----------------------------------------------------------------------------
def compute_ndvi(image):
    """NDVI = (B8 - B4) / (B8 + B4)  |  NIR vs Red  |  vegetation vigour"""
    return image.normalizedDifference(["B8", "B4"]).rename("NDVI")


def compute_ndmi(image):
    """NDMI = (B8 - B11) / (B8 + B11)  |  NIR vs SWIR1  |  canopy moisture"""
    return image.normalizedDifference(["B8", "B11"]).rename("NDMI")


def compute_nbr(image):
    """NBR = (B8A - B12) / (B8A + B12)  |  narNIR vs SWIR2  |  fire/char"""
    return image.normalizedDifference(["B8A", "B12"]).rename("NBR")


# Single-date index images
pre_ndvi = compute_ndvi(pre_composite)
post_ndvi = compute_ndvi(post_composite)
pre_ndmi = compute_ndmi(pre_composite)
post_ndmi = compute_ndmi(post_composite)
pre_nbr = compute_nbr(pre_composite)
post_nbr = compute_nbr(post_composite)

# Multi-date difference images
delta_ndvi = (pre_ndvi.subtract(post_ndvi)
              .rename("dNDVI").updateMask(water_mask))
delta_ndmi = (pre_ndmi.subtract(post_ndmi)
              .rename("dNDMI").updateMask(water_mask))
delta_nbr = (post_nbr.subtract(pre_nbr)
             .rename("dNBR").updateMask(water_mask))


# -----------------------------------------------------------------------------
# Step VII: arcpy front-end helpers  (replaces geemap m.addLayer)
# -----------------------------------------------------------------------------
def download_ee_image(ee_image, name, scale=DOWNLOAD_SCALE, region=None,
                      crs=EXPORT_CRS):
    """Download an EE image to a local GeoTIFF via getDownloadURL.

    Returns the path to the .tif, or None on failure. For large AOIs the
    EE request-size ceiling may reject the call; use the toDrive path in
    Step X instead when that happens.
    """
    region = region if region is not None else roi
    params = {
        "name": name,
        "scale": scale,
        "region": region,
        "crs": crs,
        "filePerBand": False,
        "format": "GEO_TIFF",
    }
    try:
        url = ee_image.getDownloadURL(params)
    except Exception as exc:                       # noqa: BLE001
        print("  getDownloadURL failed for {}: {}".format(name, exc))
        return None

    tif_path = os.path.join(OUTPUT_DIR, name + ".tif")
    zip_path = os.path.join(OUTPUT_DIR, name + ".zip")
    try:
        urllib.request.urlretrieve(url, zip_path)
    except Exception as exc:                       # noqa: BLE001
        print("  download failed for {}: {}".format(name, exc))
        return None

    # getDownloadURL returns a single GeoTIFF when format=GEO_TIFF, but older
    # endpoints hand back a zip. Handle both.
    if zipfile.is_zipfile(zip_path):
        with zipfile.ZipFile(zip_path) as zf:
            tif_members = [n for n in zf.namelist() if n.lower().endswith(".tif")]
            if not tif_members:
                print("  no GeoTIFF inside archive for {}".format(name))
                return None
            zf.extract(tif_members[0], OUTPUT_DIR)
            extracted = os.path.join(OUTPUT_DIR, tif_members[0])
            if extracted != tif_path:
                if os.path.exists(tif_path):
                    os.remove(tif_path)
                os.rename(extracted, tif_path)
        os.remove(zip_path)
    else:
        os.replace(zip_path, tif_path)

    return tif_path


def add_to_map(tif_path, layer_name, colorizer=None, visible=True):
    """Add a downloaded GeoTIFF to the active Pro map (replaces m.addLayer).

    colorizer: optional dict understood by this helper:
      {"type": "classified", "classes": [(value, "R G B"), ...]}  or
      {"type": "stretch", "palette_hex": ["#...", ...], "min": x, "max": y}
    Symbology beyond a colormap is best finished in the Pro UI; the .tif is
    a standard raster you can restyle freely.
    """
    if tif_path is None:
        return None
    if _active_map is None:
        print("  (no active map) saved: {}".format(tif_path))
        return None

    layer = _active_map.addDataFromPath(tif_path)
    layer.name = layer_name
    layer.visible = visible

    # Apply a simple colormap when the raster carries integer classes.
    if colorizer and colorizer.get("type") == "classified":
        try:
            _apply_class_colormap(tif_path, colorizer["classes"])
        except Exception as exc:                   # noqa: BLE001
            print("  colormap note for {}: {}".format(layer_name, exc))
    print("  layer added: {}".format(layer_name))
    return layer


def _apply_class_colormap(tif_path, classes):
    """Bake a .clr colormap next to the raster and apply it with arcpy.
    classes: list of (pixel_value, 'R G B') tuples."""
    clr_path = os.path.splitext(tif_path)[0] + ".clr"
    with open(clr_path, "w") as fh:
        for value, rgb in classes:
            fh.write("{} {}\n".format(value, rgb))
    arcpy.management.AddColormap(tif_path, "", clr_path)


# Center the map on the ROI (replaces geemap m.set_center).
if _active_map is not None:
    try:
        view = _aprx.activeView
        if hasattr(view, "camera"):
            ext = arcpy.Extent(-81.79362, 48.68688, -81.19107, 49.08762,
                               spatial_reference=arcpy.SpatialReference(4326))
            view.camera.setExtent(ext)
    except Exception as exc:                        # noqa: BLE001
        print("Could not set map extent automatically: {}".format(exc))


# -----------------------------------------------------------------------------
# Step VIII: Raster histograms (matplotlib, saved to OUTPUT_DIR)
# -----------------------------------------------------------------------------
#  Inspect the spectral distribution BEFORE committing to thresholds.
#  Unimodal near 0 = mostly noise/phenology; bimodal = real disturbance signal.

def _histogram_png(delta_image, band_key, thresholds, title, png_name):
    hist = delta_image.reduceRegion(
        reducer=ee.Reducer.fixedHistogram(-0.5, 0.8, 130),
        geometry=roi, scale=20, maxPixels=int(1e9))
    result = hist.getInfo()
    hist_data = np.array(result[band_key])
    bin_centers = hist_data[:, 0]
    counts = hist_data[:, 1]

    plt.figure(figsize=(11, 4))
    plt.bar(bin_centers, counts, width=0.01, color="steelblue",
            edgecolor="none", alpha=0.8)
    for thr, color, label in thresholds:
        plt.axvline(thr, color=color, lw=1.2, linestyle="--", label=label)
    plt.xlabel("{} value".format(band_key))
    plt.ylabel("Pixel count")
    plt.title(title)
    plt.legend()
    plt.tight_layout()
    out_png = os.path.join(OUTPUT_DIR, png_name)
    plt.savefig(out_png, dpi=150)
    plt.close()
    print("  histogram saved: {}".format(out_png))


_histogram_png(delta_ndmi, "dNDMI",
               [(0.15, "orange", "Low"), (0.30, "red", "Mod"),
                (0.45, "darkred", "High")],
               "dNDMI pixel distribution", "dNDMI_histogram_B.png")

_histogram_png(delta_ndvi, "dNDVI",
               [(0.10, "orange", "Low"), (0.20, "red", "Mod"),
                (0.35, "darkred", "High")],
               "dNDVI pixel distribution", "dNDVI_histogram_B.png")

_histogram_png(delta_nbr, "dNBR",
               [(0.10, "orange", "Low"), (0.27, "red", "Mod"),
                (0.44, "darkred", "High")],
               "dNBR pixel distribution", "dNBR_histogram_B.png")


# -----------------------------------------------------------------------------
# Step IX: Severity classes  (unchanged from the QGIS version)
# -----------------------------------------------------------------------------
def classify_delta_ndvi(delta):
    """dNDVI canopy loss - harvest/deforestation detection (SOP Step 4A)."""
    return (delta
            .where(delta.lt(0.15), 0)
            .where(delta.gte(0.15).And(delta.lt(0.20)), 1)
            .where(delta.gte(0.20).And(delta.lt(0.30)), 2)
            .where(delta.gte(0.30), 3)
            .rename("dNDVI_class").toInt16())


def classify_delta_ndmi(delta):
    """dNDMI moisture stress - pest/beetle/drought detection (SOP Step 3C).
    1 = emerging (0.05-0.15), 2 = moderate (0.15-0.25), 3 = high (>0.25)."""
    return (delta
            .where(delta.lt(0.05), 0)
            .where(delta.gte(0.05).And(delta.lt(0.15)), 1)
            .where(delta.gte(0.15).And(delta.lt(0.25)), 2)
            .where(delta.gte(0.25), 3)
            .rename("dNDMI_class").toInt16())


def classify_ndbr(delta):
    """dNBR burn severity - MTBS/USFS PNW thresholds (post minus pre)."""
    return (delta
            .where(delta.lt(0.10), 0)
            .where(delta.gte(0.10).And(delta.lt(0.27)), 1)
            .where(delta.gte(0.27).And(delta.lt(0.44)), 2)
            .where(delta.gte(0.44), 3)
            .rename("NDBR_class").toInt16())


delta_ndvi_class = classify_delta_ndvi(delta_ndvi)
delta_ndmi_class = classify_delta_ndmi(delta_ndmi)
delta_nbr_class = classify_ndbr(delta_nbr)

# Mask class 0 (undisturbed -> transparent)
delta_ndvi_disturbed = delta_ndvi_class.updateMask(delta_ndvi_class.gt(0))
delta_ndmi_disturbed = delta_ndmi_class.updateMask(delta_ndmi_class.gt(0))
delta_nbr_disturbed = delta_nbr_class.updateMask(delta_nbr_class.gt(0))


# -----------------------------------------------------------------------------
# Step X: Visualization -> download + add to the active Pro map
# -----------------------------------------------------------------------------
#  RGB composites are downloaded as-is (float reflectance); style the stretch in
#  Pro. Classified layers get a 3-class Low/Mod/High colormap baked in.

CLR_DNDVI = {"type": "classified",
             "classes": [(1, "255 237 160"), (2, "252 78 42"), (3, "128 0 38")]}
CLR_DNDMI = {"type": "classified",
             "classes": [(1, "254 178 76"), (2, "253 141 60"), (3, "177 0 38")]}
CLR_DNBR = {"type": "classified",
            "classes": [(1, "255 237 160"), (2, "252 78 42"), (3, "128 0 38")]}

# Set ADD_SINGLE_PERIOD = True to render the RP1 single-period layers.
ADD_SINGLE_PERIOD = True

if ADD_SINGLE_PERIOD:
    print("Downloading and adding single-period (RP1) layers...")

    # Classified disturbance layers (shown)
    add_to_map(download_ee_image(delta_ndvi_disturbed, "dNDVI_canopy_loss"),
               "dNDVI - Canopy Loss     [Low/Mod/High]", CLR_DNDVI, visible=True)
    add_to_map(download_ee_image(delta_ndmi_disturbed, "dNDMI_moisture_stress"),
               "dNDMI - Moisture Stress [Low/Mod/High]", CLR_DNDMI, visible=True)
    add_to_map(download_ee_image(delta_nbr_disturbed, "dNBR_burn_severity"),
               "dNBR  - Burn Severity   [Low/Mod/High]", CLR_DNBR, visible=True)

    # Continuous deltas + RGB (off by default; download only if you want them)
    ADD_CONTINUOUS = False
    if ADD_CONTINUOUS:
        add_to_map(download_ee_image(delta_ndvi, "dNDVI_continuous"),
                   "dNDVI continuous", visible=False)
        add_to_map(download_ee_image(delta_ndmi, "dNDMI_continuous"),
                   "dNDMI continuous", visible=False)
        add_to_map(download_ee_image(delta_nbr, "dNBR_continuous"),
                   "dNBR continuous", visible=False)
        add_to_map(download_ee_image(pre_composite.select(["B4", "B3", "B2"]),
                                     "pre_RGB"), "Pre RGB", visible=False)
        add_to_map(download_ee_image(post_composite.select(["B4", "B3", "B2"]),
                                     "post_RGB"), "Post RGB", visible=False)


# -----------------------------------------------------------------------------
# Step XI: Export to Google Drive (set EXPORT = True) - fallback for large AOIs
# -----------------------------------------------------------------------------
#  Use this when getDownloadURL rejects the request (AOI too large at 10 m).
#  Exports 10 m GeoTIFFs to Drive; download them, then add to Pro manually or
#  with arcpy.mp.addDataFromPath.

EXPORT = False

if EXPORT:
    export_layers = {
        "dNDVI_canopy_loss_classified":     delta_ndvi_disturbed,
        "dNDMI_moisture_stress_classified": delta_ndmi_disturbed,
        "dNBR_burn_severity_classified":    delta_nbr_disturbed,
        "pre_RGB":                          pre_composite,
        "post_RGB":                         post_composite,
    }
    for name, layer in export_layers.items():
        task = ee.batch.Export.image.toDrive(
            image=layer, description=name, folder="GEE_Exports",
            fileNamePrefix=name, scale=10, region=roi, crs=EXPORT_CRS,
            maxPixels=int(1e13), fileFormat="GeoTIFF")
        task.start()
        print("Export started: {}".format(name))


# =============================================================================
# Step XII: Multi-period reporting stack (RP vintages)
# =============================================================================
RP_DATES = {
    "RP1-Vintage-2024": {"pre_start": "2023-11-01", "pre_end": "2024-02-01",
                         "post_start": "2024-11-01", "post_end": "2025-02-01"},
    "RP1-Vintage-2025": {"pre_start": "2024-11-01", "pre_end": "2025-02-01",
                         "post_start": "2025-11-01", "post_end": "2026-02-01"},
}

rp_results = {}

for rp_name, dates in RP_DATES.items():
    rp_pre = build_composite(dates["pre_start"], dates["pre_end"], roi)
    rp_post = build_composite(dates["post_start"], dates["post_end"], roi)

    rp_pre_ndvi = compute_ndvi(rp_pre)
    rp_post_ndvi = compute_ndvi(rp_post)
    rp_pre_ndmi = compute_ndmi(rp_pre)
    rp_post_ndmi = compute_ndmi(rp_post)
    rp_pre_nbr = compute_nbr(rp_pre)
    rp_post_nbr = compute_nbr(rp_post)

    rp_dndvi = (rp_pre_ndvi.subtract(rp_post_ndvi)
                .rename("dNDVI").updateMask(water_mask))
    rp_dndmi = (rp_pre_ndmi.subtract(rp_post_ndmi)
                .rename("dNDMI").updateMask(water_mask))
    rp_dnbr = (rp_post_nbr.subtract(rp_pre_nbr)
               .rename("dNBR").updateMask(water_mask))

    rp_dndvi_cls = classify_delta_ndvi(rp_dndvi)
    rp_dndmi_cls = classify_delta_ndmi(rp_dndmi)
    rp_dnbr_cls = classify_ndbr(rp_dnbr)

    rp_dndvi_dist = rp_dndvi_cls.updateMask(rp_dndvi_cls.gt(0))
    rp_dndmi_dist = rp_dndmi_cls.updateMask(rp_dndmi_cls.gt(0))
    rp_dnbr_dist = rp_dnbr_cls.updateMask(rp_dnbr_cls.gt(0))

    rp_results[rp_name] = {
        "pre_RGB": rp_pre, "post_RGB": rp_post,
        "dNDVI": rp_dndvi_dist, "dNDMI": rp_dndmi_dist, "dNBR": rp_dnbr_dist,
    }

    # Add classified layers to the active map (set ADD_RP_STACK = True).
    ADD_RP_STACK = False
    if ADD_RP_STACK:
        year_label = "{}-{}".format(dates["pre_start"][:4],
                                    dates["post_start"][:4])
        add_to_map(download_ee_image(rp_dndvi_dist,
                                     "{}_dNDVI".format(rp_name)),
                   "{} dNDVI Canopy Loss [{}]".format(rp_name, year_label),
                   CLR_DNDVI, visible=True)
        add_to_map(download_ee_image(rp_dndmi_dist,
                                     "{}_dNDMI".format(rp_name)),
                   "{} dNDMI Moisture Stress [{}]".format(rp_name, year_label),
                   CLR_DNDMI, visible=True)
        add_to_map(download_ee_image(rp_dnbr_dist,
                                     "{}_dNBR".format(rp_name)),
                   "{} dNBR Burn Severity [{}]".format(rp_name, year_label),
                   CLR_DNBR, visible=True)
        print("{} ({}) - layers added".format(rp_name, year_label))


# -----------------------------------------------------------------------------
# Step XIII: Multi-period export to Drive (set EXPORT_STACK = True)
# -----------------------------------------------------------------------------
EXPORT_STACK = False

if EXPORT_STACK:
    for rp_name, layers in rp_results.items():
        for layer_name, layer_img in layers.items():
            export_name = "{}_{}".format(rp_name, layer_name)
            task = ee.batch.Export.image.toDrive(
                image=layer_img, description=export_name, folder="GEE_Exports",
                fileNamePrefix=export_name, scale=10, region=roi,
                crs=EXPORT_CRS, maxPixels=int(1e13), fileFormat="GeoTIFF")
            task.start()
            print("Export started: {}".format(export_name))


# =============================================================================
# Method notes
# =============================================================================
#  Patchy composites: widen filterDate or relax the clear threshold if the
#  quality mosaic shows gaps; thin collections leave holes.
#
#  Threshold recalibration: run Step VIII histograms before committing to
#  thresholds. A good signal is bimodal with a clear gap past ~0.15. If
#  unimodal, widen the window or switch to July-August composites.
#
#  Request-size ceiling: getDownloadURL (Step X) has a per-request byte limit.
#  At DOWNLOAD_SCALE = 20 this ROI is fine; at 10 m it may be rejected, in which
#  case flip EXPORT / EXPORT_STACK to True and pull the GeoTIFFs from Drive.
#
#  Band naming: delta band names follow the d-prefix convention
#  (dNDVI -> dNDVI_class, dNDMI -> dNDMI_class, dNBR -> dNBR_class). Use these
#  exact strings as reduceRegion result keys.
