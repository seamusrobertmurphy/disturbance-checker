"""Corroboration layers listed in GeoLibre's Layers panel when the site opens.

The deploy writes these into the startup project, one folder per source and
every folder collapsed. Only the carbon projects are drawn when the site opens,
because with every layer on each pan sent hundreds of image requests to the
federal services at once. The rest are switched on from the Layers panel, a
layer or a whole folder at a time. Most are rasters drawn by the publisher's own
map or image service, one 256 pixel image per map tile, so nothing is copied
into this site and every layer is as current as its service.

On 2026-09-13 every layer answered a browser request from
https://prototype-tools.github.io with a CORS header and drew a tile, a zoom 4
tile over the western United States for each layer except the Insect and
Disease Survey, which drew at zoom 12 over a damage area of its year.

The Forest Service draws that survey only at 1:250,000 or larger, and a zoom 11
web map tile is about 1:273,000 at the default 96 dpi, so tiles came back blank
until zoom 12. The server computes scale from the requested dpi, and the damage
area layers ask for dpi 0.2, which puts a zoom 3 tile at about 1:145,600 and
lets the areas draw from zoom 3. At that dpi the point symbols shrink below a
pixel, so the damage points, published for 2023 to 2025 only, are separate
layers at the default dpi that draw from zoom 12.

WFIGS perimeters, WFIGS incident points, the interagency historic perimeters,
National Park Service boundaries and two PAD-US 4.1 layers are feature services
with no map drawing endpoint. The deploy snapshots them into PMTiles with
fire_snapshots.py, snapshots GRIP4 North America main roads from its published
file geodatabase, publishes both under snapshots/, and lists them here from
snapshot.json and roads.json.

Registered carbon project boundaries come from the global database of
Karnik et al. (2024), https://doi.org/10.5281/zenodo.11459391, which
carbon_projects.py tiles into one PMTiles file per registry, listed here from
carbon.json.
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
    # Typed as WMS because each tile is an image requested by bounding box, which
    # is how GeoLibre draws WMS. As xyz, GeoLibre tries on opening to resolve
    # the service address into an {x}/{y}/{z} template, fails, and logs a
    # warning per layer. The service address sits in metadata for the same
    # reason: in the source it would be read as a WMS endpoint.
    source = {
        "type": "raster",
        "tiles": [tiles],
        "tileSize": 256,
        "attribution": attribution,
    }
    if minzoom is not None:
        source["minzoom"] = minzoom
    return {
        "id": layer_id,
        "name": name,
        "type": "wms",
        "source": source,
        "visible": True,
        "opacity": 0.8,
        "metadata": {"corroboration": True, "serviceUrl": url},
    }


def _insect_and_disease(fire_snapshot=None, site=""):
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
    attribution = "USDA Forest Service, Forest Health Protection and its partners"
    for year in range(2025, 2020, -1):
        layers.append(
            _layer(
                f"corroboration-ids-{year}",
                f"Insect and disease survey {year}, damage areas",
                ids,
                _mapserver(ids, "1", {"1": f"survey_year = {year}"}) + "&dpi=0.2",
                attribution,
                minzoom=3,
            )
        )
    # The service draws the damage points only at 1:250,000 or larger, so they
    # are copied into PMTiles by fire_snapshots.py and drawn from tiles here,
    # which puts them on the map at every zoom.
    layers += _damage_points(fire_snapshot, site, attribution)
    return layers


def _damage_points(fire_snapshot, site, attribution):
    from pathlib import Path

    if not fire_snapshot or not Path(fire_snapshot).is_file():
        return []
    snapshot = json.loads(Path(fire_snapshot).read_text())
    dataset = snapshot["datasets"].get("ids-points")
    if not dataset:
        return []
    layers = []
    for name in sorted(dataset["files"], reverse=True):
        year = name.rsplit("-", 1)[1]
        count = dataset["files"][name]["features"]
        layers.append(_pmtiles_layer(
            f"corroboration-{name}",
            f"Insect and disease survey {year}, damage points ({count:,})",
            f"{site}snapshots/{name}.pmtiles",
            {"fillColor": "#e65100", "strokeColor": "#7a2f00", "circleRadius": 3, "strokeWidth": 1},
            source_layer=dataset.get("layer", "damage"),
            about=_about(attribution, dataset.get("service"), snapshot["date"], count),
        ))
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


def _pmtiles_layer(layer_id, name, url, style, source_layer="fires", about=None):
    # The fields GeoLibre's own Add Data dialog writes for a PMTiles address.
    # `about` adds the publisher, source service, copy date and feature count
    # that the Layers panel's hover card and right-click menu show.
    return {
        "id": layer_id,
        "name": name,
        "type": "pmtiles",
        "source": {
            "sourceId": layer_id,
            "sourceLayers": [source_layer],
            "tileType": "vector",
            "type": "vector",
            "url": url,
        },
        "visible": True,
        "opacity": 1,
        "style": style,
        "metadata": {
            "corroboration": True,
            "externalNativeLayer": True,
            "nativeLayerIds": [f"{layer_id}-{source_layer}-{kind}" for kind in ("fill", "line", "circle")],
            "pickable": True,
            "sourceId": layer_id,
            "sourceKind": "pmtiles-url",
            "sourceLayers": [source_layer],
            "tileType": "vector",
            **(about or {}),
        },
        "sourcePath": url,
    }


def _about(publisher, service=None, date=None, count=None, description=None):
    about = {"attribution": publisher, "serviceUrl": service, "snapshotDate": date,
             "featureCount": count, "description": description}
    return {key: value for key, value in about.items() if value is not None}


FIRE_STYLES = {
    "wfigs-perimeters": {"fillColor": "#e4572e", "strokeColor": "#9b1d20", "fillOpacity": 0.35, "strokeWidth": 1},
    "wfigs-incidents": {"fillColor": "#ff8c00", "strokeColor": "#7a3e00", "circleRadius": 3, "strokeWidth": 1},
    "nifc-history": {"fillColor": "#8b0000", "strokeColor": "#5c0000", "fillOpacity": 0.25, "strokeWidth": 1},
}
FIRE_LABELS = {
    "wfigs-perimeters": "WFIGS fire perimeters",
    "wfigs-incidents": "WFIGS incident points",
    "nifc-history": "Interagency fire perimeter history",
}
FIRE_PUBLISHER = "National Interagency Fire Center"


def _fire_records(snapshot_path, site):
    """Layers for the fire snapshot, newest year first, or None when there is no snapshot."""
    from pathlib import Path

    snapshot_path = Path(snapshot_path)
    if not snapshot_path.is_file():
        return None
    snapshot = json.loads(snapshot_path.read_text())
    layers = []
    for key in ("wfigs-perimeters", "wfigs-incidents", "nifc-history"):
        dataset = snapshot["datasets"].get(key, {})
        files = dataset.get("files", {})
        parts = sorted((name.rsplit("-", 1)[1] for name in files),
                       key=lambda part: (part.isdigit(), part), reverse=True)
        for part in parts:
            name = f"{key}-{part}"
            if part == "all":
                label = f"{FIRE_LABELS[key]}, all years"
            elif part == "earlier":
                label = f"{FIRE_LABELS[key]}, earlier years"
            else:
                label = f"{FIRE_LABELS[key]} {part}"
            count = files[name]["features"]
            layers.append(_pmtiles_layer(
                f"corroboration-{name}",
                f"{label} ({count:,})",
                f"{site}snapshots/{name}.pmtiles",
                dict(FIRE_STYLES[key]),
                about=_about(FIRE_PUBLISHER, dataset.get("service"), snapshot["date"], count),
            ))
    return snapshot["date"], layers


CARBON_STYLES = {
    "acr": "#1e88e5",
    "car": "#8e24aa",
    "verra": "#43a047",
    "gold-standard": "#fbc02d",
    "ecoregistry": "#f4511e",
    "biocarbon": "#6d4c41",
}


def _carbon_projects(carbon_snapshot, site):
    """One layer per registry from carbon_projects.py, or an empty list when it was not built."""
    from pathlib import Path

    if not carbon_snapshot or not Path(carbon_snapshot).is_file():
        return []
    carbon = json.loads(Path(carbon_snapshot).read_text())
    layers = []
    for key, entry in carbon["registries"].items():
        colour = CARBON_STYLES.get(key, "#ffffff")
        layers.append(_pmtiles_layer(
            f"corroboration-carbon-{key}",
            f"{entry['registry']} ({entry['features']:,})",
            f"{site}snapshots/carbon-{key}.pmtiles",
            {"fillColor": colour, "strokeColor": colour, "fillOpacity": 0.2, "strokeWidth": 1.5, "circleRadius": 4},
            source_layer="projects",
            about=_about(
                "Karnik, Kilbride, Goodbody, Ross and Ayrey (2024), CC BY 4.0",
                carbon["source"],
                count=entry["features"],
                description=(
                    "Registered project areas, not a census of every project. "
                    f"Entries up to {carbon['entered_to']}; projects known only by location are points."
                ),
            ),
        ))
    return layers


def _land_status(fire_snapshot, roads_snapshot, site):
    """Federal, tribal, protected and park land, and main roads, for overlap checks."""
    from pathlib import Path

    # BLM National Surface Management Agency, cached, without private and unknown land
    # https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer
    sma = "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer"
    federal = _layer(
        "corroboration-blm-sma",
        "Federal and state land, surface management agency (BLM)",
        sma,
        f"{sma}/tile/{{z}}/{{y}}/{{x}}",
        "Bureau of Land Management",
    )
    # Cached tiles are addressed by {z}/{y}/{x}, so this layer is a true XYZ layer.
    federal["type"] = "xyz"
    federal["source"]["maxzoom"] = 14
    # BIA American Indian and Alaska Native Land Area Representation
    # https://biamaps.geoplatform.gov/server/rest/services/DivLTR/BIA_AIAN_National_LAR/MapServer
    lar = "https://biamaps.geoplatform.gov/server/rest/services/DivLTR/BIA_AIAN_National_LAR/MapServer"
    # BLM National PLSS CadNSDI, townships (layer 1, from 1:4,000,000) and sections (layer 2, from 1:500,000)
    # https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer
    plss = "https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer"
    layers = [
        federal,
        _layer(
            "corroboration-blm-plss",
            "PLSS townships from zoom 8 and sections from zoom 11 (BLM CadNSDI)",
            plss,
            _mapserver(plss, "1,2"),
            "Bureau of Land Management, National PLSS CadNSDI",
            minzoom=8,
        ),
        _layer(
            "corroboration-bia-lar",
            "Tribal lands, American Indian and Alaska Native land areas (BIA)",
            lar,
            _mapserver(lar, "0"),
            "Bureau of Indian Affairs, Office of Trust Services, Division of Land Titles and Records",
        ),
    ]

    publishers = {
        "padus-federal-fee": "U.S. Geological Survey, Protected Areas Database of the United States",
        "padus-proclamation": "U.S. Geological Survey, Protected Areas Database of the United States",
        "nps-boundaries": "National Park Service, Land Resources Division",
    }
    labels = {
        "padus-federal-fee": ("PAD-US 4.1 federal fee lands", {"fillColor": "#2e7d32", "strokeColor": "#1b5e20", "fillOpacity": 0.3, "strokeWidth": 1}),
        "padus-proclamation": ("PAD-US 4.1 proclamation and planning boundaries", {"fillColor": "#1b5e20", "strokeColor": "#1b5e20", "fillOpacity": 0, "strokeWidth": 1.5}),
        "nps-boundaries": ("National park boundaries (NPS)", {"fillColor": "#6d4c41", "strokeColor": "#3e2723", "fillOpacity": 0.3, "strokeWidth": 1}),
    }
    if fire_snapshot and Path(fire_snapshot).is_file():
        snapshot = json.loads(Path(fire_snapshot).read_text())
        for key, (label, style) in labels.items():
            dataset = snapshot["datasets"].get(key)
            if not dataset:
                continue
            name = f"{key}-all"
            count = dataset["files"][name]["features"]
            layers.append(_pmtiles_layer(
                f"corroboration-{key}",
                f"{label} ({count:,})",
                f"{site}snapshots/{name}.pmtiles",
                dict(style),
                source_layer=dataset.get("layer", "areas"),
                about=_about(publishers[key], dataset.get("service"), snapshot["date"], count),
            ))
    if roads_snapshot and Path(roads_snapshot).is_file():
        layers.append(_pmtiles_layer(
            "corroboration-grip4-roads",
            "Main roads, North America, highways to tertiary (GRIP4, 2018)",
            f"{site}snapshots/grip4-north-america-main-roads.pmtiles",
            {"strokeColor": "#f5f5f5", "fillColor": "#f5f5f5", "strokeWidth": 1},
            source_layer="roads",
            about=_about(
                "GLOBIO, Global Roads Inventory Project (GRIP4), CC0",
                "https://www.globio.info/download-grip-dataset",
            ),
        ))
    return layers


def project_layers(fire_snapshot=None, roads_snapshot=None, site="", carbon_snapshot=None):
    """Return (layers, layer_groups) for a GeoLibre project.

    GeoLibre lists the last layer in the array at the top of the Layers panel,
    so the folders and the layers inside them are written bottom first, which
    leaves the carbon projects folder on top, then the survey folder with its
    newest year first. A folder with no layers, such as carbon projects when
    its build failed, is left out.
    """
    folders = [
        ("corroboration-group-carbon", "Carbon projects", _carbon_projects(carbon_snapshot, site), False),
        ("corroboration-group-ids", "Insect and disease survey", _insect_and_disease(fire_snapshot, site), False),
        ("corroboration-group-land", "Land status", _land_status(fire_snapshot, roads_snapshot, site), False),
    ]
    fires = _fire_records(fire_snapshot, site) if fire_snapshot else None
    if fires:
        _, fire_layers = fires
        folders.append(("corroboration-group-fires", "WFIGS records", fire_layers, False))
    folders += [
        ("corroboration-group-hazard", "Wildfire hazard", _wildfire_hazard(), False),
        ("corroboration-group-mtbs", "MTBS", _mtbs(), True),
        ("corroboration-group-landfire", "LANDFIRE", _landfire(), True),
    ]
    folders = [folder for folder in folders if folder[2]]
    layers, groups = [], []

    for group_id, name, members, _ in reversed(folders):
        groups.append({
            "id": group_id,
            "name": name,
            "collapsed": True,
            "visible": True,
            "opacity": 1,
        })
        for layer in reversed(members):
            layer["groupId"] = group_id
            # Only the carbon projects are drawn when the site opens. With every
            # layer on, each pan sent hundreds of image requests to the federal
            # services at once, and on 2026-09-15 a session over the Olympic
            # Peninsula logged 250 failed survey tiles in 26 seconds.
            layer["visible"] = group_id == "corroboration-group-carbon"
            layers.append(layer)
    return layers, groups


if __name__ == "__main__":
    layers, groups = project_layers()
    print(f"{len(layers)} layers in {len(groups)} folders")
