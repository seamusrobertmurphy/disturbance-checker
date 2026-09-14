"""Build PMTiles of registered carbon project boundaries for GeoLibre's Layers panel.

The source is Karnik, Kilbride, Goodbody, Ross and Ayrey (2024), A global
database of nature-based carbon offset project boundaries, released on Zenodo
under CC BY 4.0. It holds 575 avoided deforestation, afforestation and
reforestation, and improved forest management projects from six registries,
entered up to 2 May 2024, of which 42 are known only as a point. It is the
dataset behind the Earth Engine asset
projects/sat-io/open-datasets/CARBON-OFFSET-PROJECTS-GLOBAL.

Each registry becomes one PMTiles file, so a registry can be switched off on
its own. The geometry is the project area, the dataset's default; the
accounting area and reference region columns are left out, being well-known
text copies of further geometry. carbon.json records the source, the latest
entry date, and the feature count and size of each file.

The 1.7 GB of GeoPackages are downloaded into a temporary folder and removed
afterwards, unless DOWNLOAD_DIR is given, in which case files already there
are reused and kept.

Usage: python3 carbon_projects.py OUTPUT_DIR [TIPPECANOE] [DOWNLOAD_DIR]
"""

import json
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime
from pathlib import Path

# A global database of nature-based carbon offset project boundaries, Karnik et al. (2024), CC BY 4.0
# https://doi.org/10.5281/zenodo.11459391
RECORD = "https://zenodo.org/api/records/11459391"
DOI = "https://doi.org/10.5281/zenodo.11459391"
CONTINENTS = ["africa", "asia", "europe", "north_america", "oceania", "south_america"]

REGISTRIES = {
    "acr": "American Carbon Registry",
    "car": "Climate Action Reserve",
    "verra": "Verra",
    "gold-standard": "Gold Standard",
    "ecoregistry": "EcoRegistry",
    "biocarbon": "BioCarbon Registry",
}

FIELDS = {
    "Project Name": "name",
    "ProjectID": "project_id",
    "Registry Name": "registry",
    "Project Type": "type",
    "Methodology": "methodology",
    "Country": "country",
    "Project Developer Name": "developer",
    "Project Start Date": "start",
    "Project End Date": "end",
    "Date of Entry": "entered",
    "Processing Approach": "boundary_source",
    "Geometry Type": "geometry_type",
}


def download(folder):
    folder.mkdir(parents=True, exist_ok=True)
    for continent in CONTINENTS:
        target = folder / f"{continent}.gpkg"
        if target.is_file() and target.stat().st_size > 0:
            continue
        url = f"{RECORD}/files/{continent}.gpkg/content"
        print(f"downloading {url}")
        with urllib.request.urlopen(url, timeout=600) as response, open(target, "wb") as out:
            while chunk := response.read(1 << 20):
                out.write(chunk)
    return [folder / f"{continent}.gpkg" for continent in CONTINENTS]


def build(out_dir, tippecanoe, sources):
    out_dir.mkdir(parents=True, exist_ok=True)
    columns = ", ".join(f'"{old}" AS {new}' for old, new in FIELDS.items())
    written, entered = {}, []
    for key, registry in REGISTRIES.items():
        lines = out_dir / f"carbon-{key}.geojsonl"
        with open(lines, "w") as sink:
            for source in sources:
                layer = source.stem
                sql = f"SELECT {columns}, geom FROM \"{layer}\" WHERE \"Registry Name\" = '{registry}'"
                subprocess.run(
                    ["ogr2ogr", "-f", "GeoJSONSeq", "-dim", "XY", "-t_srs", "EPSG:4326",
                     "/vsistdout/", str(source), "-sql", sql],
                    check=True, stdout=sink,
                )
        count = 0
        with open(lines) as features:
            for line in features:
                if line.strip():
                    count += 1
                    date = json.loads(line)["properties"].get("entered")
                    if date:
                        entered.append(datetime.strptime(date, "%m/%d/%Y").date())
        if count == 0:
            lines.unlink()
            continue
        target = out_dir / f"carbon-{key}.pmtiles"
        subprocess.run(
            [tippecanoe, "-o", str(target), "--force", "-l", "projects", "-z", "12",
             "--no-feature-limit", "--no-tile-size-limit", "--detect-shared-borders",
             "--read-parallel", str(lines)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        lines.unlink()
        written[key] = {"registry": registry, "features": count, "bytes": target.stat().st_size}
        print(f"{registry}: {count} projects, {target.stat().st_size / 1e6:.1f} MB")
    result = {"source": DOI, "entered_to": max(entered).isoformat(), "registries": written}
    (out_dir / "carbon.json").write_text(json.dumps(result, indent=1) + "\n")
    return result


if __name__ == "__main__":
    out = Path(sys.argv[1])
    tippecanoe = sys.argv[2] if len(sys.argv) > 2 else "tippecanoe"
    if len(sys.argv) > 3:
        build(out, tippecanoe, download(Path(sys.argv[3])))
    else:
        with tempfile.TemporaryDirectory() as folder:
            build(out, tippecanoe, download(Path(folder)))
