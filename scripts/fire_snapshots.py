"""Snapshot national feature services into PMTiles for GeoLibre's Layers panel.

WFIGS perimeters, WFIGS incident points, the interagency historic perimeters,
National Park Service boundaries and two PAD-US 4.1 layers are ArcGIS feature
services with no map drawing endpoint, and GeoLibre can load one only by
downloading every record at once. This script pages through each
service, 2,000 records a request, writes one newline-delimited GeoJSON file per
layer, and has tippecanoe turn each into a PMTiles archive the site serves
beside the app. snapshot.json records the date and the feature count of every
file, and the startup project names each layer with that date.

Only the fields a verifier reads off a feature are kept, and polygon vertices are
thinned to 0.0001 degrees, about 10 m, before tiling.

Usage: python3 fire_snapshots.py OUTPUT_DIR [TIPPECANOE]
"""

import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"
PADUS = "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services"
PADUS_FIELDS = {
    "Unit_Nm": "name",
    "Mang_Name": "manager",
    "Mang_Type": "manager_type",
    "Own_Name": "owner",
    "Des_Tp": "designation",
    "GAP_Sts": "gap_status",
    "GIS_Acres": "acres",
    "State_Nm": "state",
}

DATASETS = [
    {
        "key": "wfigs-perimeters",
        # WFIGS Interagency Fire Perimeters, all years
        # https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0
        "url": f"{BASE}/WFIGS_Interagency_Perimeters/FeatureServer/0",
        "layer": "fires",
        "fields": {
            "poly_IncidentName": "name",
            "poly_GISAcres": "acres",
            "attr_FireDiscoveryDateTime": "discovered",
            "attr_FireCause": "cause",
            "attr_IncidentTypeCategory": "type",
            "attr_POOState": "state",
            "poly_IRWINID": "irwin_id",
        },
        "date_field": "attr_FireDiscoveryDateTime",
        "split": "year",
        "first_year": 2020,
        "polygons": True,
    },
    {
        "key": "wfigs-incidents",
        # WFIGS Incident Locations, all years
        # https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations/FeatureServer/0
        "url": f"{BASE}/WFIGS_Incident_Locations/FeatureServer/0",
        "layer": "fires",
        "fields": {
            "IncidentName": "name",
            "IncidentSize": "acres",
            "FireDiscoveryDateTime": "discovered",
            "FireCause": "cause",
            "IncidentTypeCategory": "type",
            "POOState": "state",
            "IrwinID": "irwin_id",
        },
        "date_field": "FireDiscoveryDateTime",
        "split": "year",
        "first_year": 2014,
        "polygons": False,
    },
    {
        "key": "nifc-history",
        # InterAgency Fire Perimeter History, all years
        # https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0
        "url": f"{BASE}/InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0",
        "layer": "fires",
        "fields": {
            "INCIDENT": "name",
            "GIS_ACRES": "acres",
            "FIRE_YEAR_INT": "year",
            "AGENCY": "agency",
            "SOURCE": "source",
            "UNQE_FIRE_ID": "fire_id",
        },
        "date_field": None,
        "split": None,
        "polygons": True,
    },
    {
        "key": "nps-boundaries",
        # National Park Service Land Resources Division, NPS Boundary
        # https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2
        "url": "https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2",
        "layer": "areas",
        "fields": {"UNIT_NAME": "name", "UNIT_CODE": "code", "UNIT_TYPE": "type", "STATE": "state", "REGION": "region"},
        "date_field": None,
        "split": None,
        "polygons": True,
    },
    {
        "key": "padus-federal-fee",
        # PAD-US 4.1, federal fee managers, authoritative
        # https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Federal_Fee_Managers_Authoritative_PADUS/FeatureServer/0
        # https://doi.org/10.5066/P96WBCHS
        "url": f"{PADUS}/Federal_Fee_Managers_Authoritative_PADUS/FeatureServer/0",
        "layer": "areas",
        "page": 1000,
        "fields": PADUS_FIELDS,
        "date_field": None,
        "split": None,
        "polygons": True,
    },
    {
        "key": "padus-proclamation",
        # PAD-US 4.1, proclamation and other planning boundaries
        # https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Proclamation_and_Other_Planning_Boundaries_PADUS/FeatureServer/0
        # https://doi.org/10.5066/P96WBCHS
        "url": f"{PADUS}/Proclamation_and_Other_Planning_Boundaries_PADUS/FeatureServer/0",
        "layer": "areas",
        "fields": PADUS_FIELDS,
        "date_field": None,
        "split": None,
        "polygons": True,
    },
]
PAGE = 2000


def _get(url, attempts=5):
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=180) as response:
                return json.load(response)
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(5 * (attempt + 1))


def _query(url, params):
    return _get(f"{url}/query?" + urllib.parse.urlencode(params))


def _page(dataset, offset):
    params = {
        "where": "1=1",
        "outFields": ",".join(dataset["fields"]),
        "orderByFields": "OBJECTID",
        "resultOffset": offset,
        "resultRecordCount": dataset.get("page", PAGE),
        "outSR": 4326,
        "geometryPrecision": 5,
        "f": "geojson",
    }
    if dataset["polygons"]:
        params["maxAllowableOffset"] = 0.0001
    page = _query(dataset["url"], params)
    if "features" not in page:
        raise RuntimeError(f"{dataset['url']} offset {offset}: {str(page)[:200]}")
    return page["features"]


def _year(dataset, props):
    if dataset["date_field"] is None:
        return props.get("year")
    stamp = props.get("discovered")
    if not isinstance(stamp, (int, float)):
        return None
    return datetime.fromtimestamp(stamp / 1000, tz=timezone.utc).year


def snapshot(dataset, out_dir, tippecanoe):
    count = _query(dataset["url"], {"where": "1=1", "returnCountOnly": "true", "f": "json"})["count"]
    offsets = list(range(0, count, dataset.get("page", PAGE)))
    files, counts = {}, Counter()

    def batches():
        # Twelve pages at a time, so a large service is never held in memory whole.
        with ThreadPoolExecutor(6) as pool:
            for start in range(0, len(offsets), 12):
                yield from pool.map(lambda offset: _page(dataset, offset), offsets[start:start + 12])

    for features in batches():
        for feature in features:
            if not feature.get("geometry"):
                continue
            props = {new: feature["properties"].get(old) for old, new in dataset["fields"].items()}
            year = _year(dataset, props)
            if isinstance(props.get("discovered"), (int, float)):
                props["discovered"] = datetime.fromtimestamp(
                    props["discovered"] / 1000, tz=timezone.utc).date().isoformat()
            props["year"] = year
            if dataset["split"] == "year":
                part = str(year) if isinstance(year, int) and year >= dataset["first_year"] else "earlier"
            else:
                part = "all"
            name = f"{dataset['key']}-{part}"
            if name not in files:
                files[name] = open(out_dir / f"{name}.geojsonl", "w")
            files[name].write(json.dumps({"type": "Feature", "geometry": feature["geometry"],
                                          "properties": props}) + "\n")
            counts[name] += 1
    for handle in files.values():
        handle.close()

    written = {}
    for name in sorted(counts):
        source = out_dir / f"{name}.geojsonl"
        target = out_dir / f"{name}.pmtiles"
        command = [tippecanoe, "-o", str(target), "--force", "-l", dataset["layer"], "-z", "12",
                   "--drop-densest-as-needed", "--extend-zooms-if-still-dropping",
                   "--read-parallel", str(source)]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        source.unlink()
        written[name] = {"features": counts[name], "bytes": target.stat().st_size}
    print(f"{dataset['url']}: {count:,} records, {len(written)} files")
    return {"service": dataset["url"], "layer": dataset["layer"], "records": count, "files": written}


def main():
    out_dir = Path(sys.argv[1])
    tippecanoe = sys.argv[2] if len(sys.argv) > 2 else "tippecanoe"
    out_dir.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc)
    result = {"date": started.date().isoformat(), "datasets": {}}
    for dataset in DATASETS:
        result["datasets"][dataset["key"]] = snapshot(dataset, out_dir, tippecanoe)
    (out_dir / "snapshot.json").write_text(json.dumps(result, indent=1) + "\n")
    minutes = (datetime.now(timezone.utc) - started).total_seconds() / 60
    total = sum(f["bytes"] for d in result["datasets"].values() for f in d["files"].values())
    print(f"Snapshot {result['date']}: {total / 1e6:.1f} MB in {minutes:.1f} minutes")


if __name__ == "__main__":
    main()
