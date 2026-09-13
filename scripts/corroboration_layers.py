"""Corroboration layers listed in GeoLibre's Layers panel when the site opens.

The deploy writes these into the startup project, one folder per source, every
layer switched off, so an operator can switch any of them on and read the
national picture without running a check. Each layer is a raster drawn by the
publisher's own map or image service, one 256 pixel image per map tile, so
nothing is copied into this site and every layer is as current as its service.

On 2026-09-13 every layer answered a browser request from
https://prototype-tools.github.io with a CORS header and drew a tile, a zoom 4
tile over the western United States for each layer except the Insect and
Disease Survey, which drew at zoom 12 over a damage area of its year. The Forest
Service caps that survey at 1:250,000, so those layers start drawing at zoom 11,
and the national Tree Canopy Assessment mortality layer, which is derived from
the same survey, sits beside them for the national view.

WFIGS perimeters, WFIGS incident points and the interagency historic
perimeters are feature services with no map drawing endpoint, so they are not
listed here.
"""

import json
from urllib.parse import quote

TILE = (
    "bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857"
    "&size=256,256&format=png32&transparent=true&f=image"
)


def _mapserver(url, layers, layer_defs=None):
    tiles = f"{url}/export?{TILE}&layers=show:{layers}"
    if layer_defs:
        tiles += "&layerDefs=" + quote(json.dumps(layer_defs), safe="")
    return tiles


def _imageserver(url, extra=""):
    return f"{url}/exportImage?{TILE}{extra}"


def _layer(layer_id, name, url, tiles, attribution, minzoom=None):
    source = {
        "type": "raster",
        "tiles": [tiles],
        "tileSize": 256,
        "url": url,
        "attribution": attribution,
    }
    if minzoom is not None:
        source["minzoom"] = minzoom
    return {
        "id": layer_id,
        "name": name,
        "type": "xyz",
        "source": source,
        "visible": False,
        "opacity": 0.8,
        "metadata": {"corroboration": True},
    }


def _insect_and_disease():
    # Tree Canopy Assessment, tree mortality 0 to 5 years, derived from the aerial survey
    # https://imagery.geoplatform.gov/iipp/rest/services/Ecosystems/USFS_EDW_TCA_TreeMortality_0_5/ImageServer
    tca = "https://imagery.geoplatform.gov/iipp/rest/services/Ecosystems/USFS_EDW_TCA_TreeMortality_0_5/ImageServer"
    layers = [
        _layer(
            "corroboration-tca-mortality",
            "Tree mortality 0 to 5 years, national, derived from the aerial survey (TCA)",
            tca,
            _imageserver(tca),
            "USDA - GEO; USDA - USFS - GO - FHAAST",
        )
    ]
    # USDA Forest Service Insect and Disease Survey, damage points (layer 0) and areas (layer 1)
    # https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer
    ids = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer"
    for year in range(2025, 2020, -1):
        where = f"survey_year = {year}"
        layers.append(
            _layer(
                f"corroboration-ids-{year}",
                f"Insect and disease survey {year}, damage areas and points (draws from zoom 11)",
                ids,
                _mapserver(ids, "0,1", {"0": where, "1": where}),
                "USDA Forest Service, Forest Health Protection and its partners",
                minzoom=11,
            )
        )
    return layers


def _wildfire_hazard():
    # Wildfire Hazard Potential for the conterminous United States, classified, 2023 (4th edition)
    # https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer
    # https://doi.org/10.2737/RDS-2015-0047-4
    whp = "https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer"
    return [
        _layer(
            "corroboration-whp-2023",
            "Wildfire Hazard Potential 2023, classified (ACR Risk Tool v2.0)",
            whp,
            _imageserver(whp),
            "USDA Forest Service, Fire Modeling Institute; Dillon (2023), https://doi.org/10.2737/RDS-2015-0047-4",
        )
    ]


def _mtbs():
    attribution = "Monitoring Trends in Burn Severity Project (U.S. Geological Survey and USDA Forest Service)"
    # MTBS burned area boundaries, all years (layer 63)
    # https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer
    boundaries = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer"
    layers = [
        _layer(
            "corroboration-mtbs-boundaries",
            "MTBS burned area boundaries, all years",
            boundaries,
            _mapserver(boundaries, "63"),
            attribution,
        )
    ]
    # MTBS burn severity mosaics for the conterminous United States, one image layer per year,
    # layer id 4 x (year - 1984) + 3
    # https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_MTBS_CONUS/MapServer
    severity = "https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_MTBS_CONUS/MapServer"
    for year in range(2024, 1983, -1):
        layers.append(
            _layer(
                f"corroboration-mtbs-severity-{year}",
                f"MTBS burn severity {year}",
                severity,
                _mapserver(severity, str(4 * (year - 1984) + 3)),
                attribution,
            )
        )
    return layers


# Final layers are Dist, LANDFIRE's first look is LDist and its preliminary layer, which adds
# satellite change detection, is PDist.
LANDFIRE_SERVICES = [
    "LF2025_PDist25_CONUS", "LF2025_LDist25_CONUS", "LF2024_Dist24_CONUS",
    "LF2023_Dist23_CONUS", "LF2022_Dist22_CONUS", "LF2022_Dist21_CONUS",
    "LF2020_Dist20_CONUS", "LF2020_Dist19_CONUS", "LF2020_Dist18_CONUS",
    "LF2020_Dist17_CONUS", "LF2016_Dist16_CONUS", "LF2016_Dist15_CONUS",
    "LF2014_Dist14_CONUS", "LF2014_Dist13_CONUS", "LF2012_Dist12_CONUS",
    "LF2012_Dist11_CONUS", "LF2010_Dist10_CONUS", "LF2010_Dist09_CONUS",
    "LF2008_Dist08_CONUS", "LF2001_Dist07_CONUS", "LF2001_Dist06_CONUS",
    "LF2001_Dist05_CONUS", "LF2001_Dist04_CONUS", "LF2001_Dist03_CONUS",
    "LF2001_Dist02_CONUS", "LF2001_Dist01_CONUS", "LF2001_Dist00_CONUS",
    "LF2001_Dist99_CONUS",
]


def _landfire():
    layers = []
    for service in LANDFIRE_SERVICES:
        product = service.split("_")[1]
        kind, yy = product[:-2], product[-2:]
        year = (1900 if yy == "99" else 2000) + int(yy)
        label = {"Dist": "final", "LDist": "first look", "PDist": "preliminary"}[kind]
        # LANDFIRE annual disturbance, conterminous United States. noData=0 leaves undisturbed
        # ground transparent, which the service otherwise paints black.
        # https://lfps.usgs.gov/arcgis/rest/services/Landfire_Disturbance
        url = f"https://lfps.usgs.gov/arcgis/rest/services/Landfire_Disturbance/{service}/ImageServer"
        layers.append(
            _layer(
                f"corroboration-landfire-{product.lower()}",
                f"LANDFIRE annual disturbance {year}, {label}",
                url,
                _imageserver(url, "&noData=0"),
                "LANDFIRE, U.S. Department of the Interior and U.S. Department of Agriculture",
            )
        )
    return layers


def project_layers():
    """Return (layers, layer_groups) for a GeoLibre project, folders in panel order."""
    folders = [
        ("corroboration-group-ids", "Insect and disease survey", _insect_and_disease(), False),
        ("corroboration-group-hazard", "Wildfire hazard", _wildfire_hazard(), False),
        ("corroboration-group-mtbs", "MTBS", _mtbs(), True),
        ("corroboration-group-landfire", "LANDFIRE disturbance", _landfire(), True),
    ]
    layers, groups = [], []
    for group_id, name, members, collapsed in folders:
        groups.append({
            "id": group_id,
            "name": name,
            "collapsed": collapsed,
            "visible": True,
            "opacity": 1,
        })
        for layer in members:
            layer["groupId"] = group_id
            layers.append(layer)
    return layers, groups


if __name__ == "__main__":
    layers, groups = project_layers()
    print(f"{len(layers)} layers in {len(groups)} folders")
