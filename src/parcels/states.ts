// Statewide parcel services the parcel lookup queries, one per state.
//
// Each was found and tested on 2026-09-14: the layer answered a point query
// from https://prototype-tools.github.io with a CORS header and GeoJSON output
// and returned a parcel at a rural point inside the state. Thirteen publish an
// owner name. The others publish a parcel id and, for some, an address or
// acreage, and the lookup says so rather than leaving the owner blank.
//
// Field names are the publisher's own. A null field is one the service does
// not carry. New Jersey carries OWNER_NAME but every value was empty when
// counted, so it is null here.

export interface StateParcelService {
  state: string;
  name: string;
  url: string;
  page: string | null;
  bbox: [number, number, number, number];
  fields: {
    owner: string | null;
    parcelId: string | null;
    acres: string | null;
    address: string | null;
    county: string | null;
  };
  note: string | null;
}

export const STATE_PARCEL_SERVICES: StateParcelService[] = [
  {
    // Montana Cadastral Framework
    // https://services.arcgis.com/qnjIrwR8z5Izc0ij/arcgis/rest/services/Montana_Cadastral_Framework/FeatureServer/1
    state: "MT",
    name: "Montana Cadastral Framework",
    url: "https://services.arcgis.com/qnjIrwR8z5Izc0ij/arcgis/rest/services/Montana_Cadastral_Framework/FeatureServer/1",
    page: "https://www.arcgis.com/home/item.html?id=f161a98b347b4cf29d371a6d7697912a",
    bbox: [-116.17857, 44.23772, -103.61113, 49.18074],
    fields: {
      owner: "OwnerName",
      parcelId: "PARCELID",
      acres: "GISAcres",
      address: "AddressLine1",
      county: "CountyName",
    },
    note: null,
  },
  {
    // Wisconsin Statewide Parcels DB
    // https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0
    state: "WI",
    name: "Wisconsin Statewide Parcels DB",
    url: "https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=2386813b23ea4e51a009f7d1d6b76e02",
    bbox: [-92.88863, 42.49192, -86.764, 47.08072],
    fields: {
      owner: "OWNERNME1",
      parcelId: "PARCELID",
      acres: "GISACRES",
      address: "SITEADRESS",
      county: "CONAME",
    },
    note: null,
  },
  {
    // North Carolina Parcels (Polygons)
    // https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1
    state: "NC",
    name: "North Carolina Parcels (Polygons)",
    url: "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1",
    page: "https://www.arcgis.com/home/item.html?id=1de3d7d828ce4813b838ddf055b40317",
    bbox: [-84.50442, 33.73053, -75.36277, 37.81597],
    fields: {
      owner: "ownname",
      parcelId: "parno",
      acres: "gisacres",
      address: "siteadd",
      county: "cntyname",
    },
    note: null,
  },
  {
    // VT Data - Statewide Standardized Parcel Data - parcel polygons
    // https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer/0
    state: "VT",
    name: "VT Data - Statewide Standardized Parcel Data - parcel polygons",
    url: "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=09cf47e1cf82465e99164762a04f3ce6",
    bbox: [-73.45416, 42.72262, -71.46537, 45.01835],
    fields: {
      owner: "OWNER1",
      parcelId: "SPAN",
      acres: "ACRESGL",
      address: "E911ADDR",
      county: null,
    },
    note: null,
  },
  {
    // Parcels and MOD-IV Composite of NJ, Web Mercator (3857)
    // https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0
    state: "NJ",
    name: "Parcels and MOD-IV Composite of NJ, Web Mercator (3857)",
    url: "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=533599bbfbaa4748bf39faf1375a8a9c",
    bbox: [-75.55957, 38.92466, -73.90245, 41.35689],
    fields: {
      owner: null,
      parcelId: "PAMS_PIN",
      acres: "CALC_ACRE",
      address: "PROP_LOC",
      county: "COUNTY",
    },
    note: null,
  },
  {
    // Connecticut CAMA and Parcel Layer
    // https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/arcgis/rest/services/Connecticut_CAMA_and_Parcel_Layer/FeatureServer/0
    state: "CT",
    name: "Connecticut CAMA and Parcel Layer",
    url: "https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/arcgis/rest/services/Connecticut_CAMA_and_Parcel_Layer/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=82a733423a244c43a9d4bf552954cea9",
    bbox: [-73.74217, 40.97992, -71.78134, 42.05261],
    fields: {
      owner: "Owner",
      parcelId: "Parcel_ID",
      acres: "Land_Acres",
      address: "Location",
      county: null,
    },
    note: null,
  },
  {
    // WVParcels
    // https://services.wvgis.wvu.edu/arcgis/rest/services/Planning_Cadastre/WV_Parcels/MapServer/0
    state: "WV",
    name: "WVParcels",
    url: "https://services.wvgis.wvu.edu/arcgis/rest/services/Planning_Cadastre/WV_Parcels/MapServer/0",
    page: null,
    bbox: [-82.70236, 37.16006, -77.6588, 40.63592],
    fields: {
      owner: "FullOwnerName",
      parcelId: "CleanParcelID",
      acres: "CALC_ACRE",
      address: "FullPhysicalAddress",
      county: "COUNTY",
    },
    note: null,
  },
  {
    // Colorado Public Parcels
    // https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0
    state: "CO",
    name: "Colorado Public Parcels",
    url: "https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=55234e04218f47c9868900e439fcbd5a",
    bbox: [-109.06017, 36.99197, -102.04665, 41.0033],
    fields: {
      owner: "owner",
      parcelId: "parcel_id",
      acres: "landAcres",
      address: "situsAdd",
      county: "countyName",
    },
    note: null,
  },
  {
    // Florida_Statewide_Cadastral
    // https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0
    state: "FL",
    name: "Florida_Statewide_Cadastral",
    url: "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=64a6281f835c4b09a8abcc4e309230de",
    bbox: [-87.63799, 24.41173, -79.77018, 31.04262],
    fields: {
      owner: "OWN_NAME",
      parcelId: "PARCEL_ID",
      acres: null,
      address: "PHY_ADDR1",
      county: "CO_NO",
    },
    note: "County is a county number, not a name.",
  },
  {
    // Massachusetts Property Tax Parcels
    // https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0
    state: "MA",
    name: "Massachusetts Property Tax Parcels",
    url: "https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=73d4c766167848b795f1048cad3919c7",
    bbox: [-73.53332, 41.23055, -69.89929, 42.88832],
    fields: {
      owner: "OWNER1",
      parcelId: "MAP_PAR_ID",
      acres: "LOT_SIZE",
      address: "SITE_ADDR",
      county: null,
    },
    note: "Lot size units are given in LOT_UNITS.",
  },
  {
    // Parcels, Compiled from Opt-In Open Data Counties, Minnesota
    // https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer/1
    state: "MN",
    name: "Parcels, Compiled from Opt-In Open Data Counties, Minnesota",
    url: "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer/1",
    page: "https://www.arcgis.com/home/item.html?id=69148d3959194a05a23964cc60f6517b",
    bbox: [-97.24526, 43.43615, -89.39721, 49.40315],
    fields: {
      owner: "owner_name",
      parcelId: "county_pin",
      acres: "acres_poly",
      address: null,
      county: "co_name",
    },
    note: "Opt-in counties only, not all 87.",
  },
  {
    // Public Idaho Parcels 
    // https://services1.arcgis.com/CNPdEkvnGl65jCX8/arcgis/rest/services/Public_Idaho_Parcels_/FeatureServer/7
    state: "ID",
    name: "Public Idaho Parcels ",
    url: "https://services1.arcgis.com/CNPdEkvnGl65jCX8/arcgis/rest/services/Public_Idaho_Parcels_/FeatureServer/7",
    page: "https://www.arcgis.com/home/item.html?id=65a3f7c6d4ca404ba6ab677913953b35",
    bbox: [-117.37185, 41.96025, -110.80538, 46.66093],
    fields: {
      owner: "OWNER1",
      parcelId: "PARCEL_ID",
      acres: "ASR_ACRES",
      address: "SITE_ADD",
      county: "County",
    },
    note: null,
  },
  {
    // Alaska Statewide Parcels
    // https://services1.arcgis.com/7HDiw78fcUiM2BWn/arcgis/rest/services/AK_Parcels/FeatureServer/0
    state: "AK",
    name: "Alaska Statewide Parcels",
    url: "https://services1.arcgis.com/7HDiw78fcUiM2BWn/arcgis/rest/services/AK_Parcels/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=458be3d8aafa47cd882af05cee983f6b",
    bbox: [-166.84114, 53.80537, -129.99544, 71.38949],
    fields: {
      owner: "owner",
      parcelId: "parcel_id",
      acres: null,
      address: null,
      county: "local_gov",
    },
    note: null,
  },
  {
    // PARCEL_POLYGON_CAMP
    // https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6
    state: "AR",
    name: "PARCEL_POLYGON_CAMP",
    url: "https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6",
    page: null,
    bbox: [-94.61829, 32.9693, -89.62164, 36.53177],
    fields: {
      owner: "ownername",
      parcelId: "parcelid",
      acres: null,
      address: "adrlabel",
      county: "county",
    },
    note: null,
  },
  {
    // Parcel Boundaries of Indiana Current
    // https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0
    state: "IN",
    name: "Parcel Boundaries of Indiana Current",
    url: "https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=70565d886f1e4528a43a86be6ce5c2f3",
    bbox: [-88.09731, 37.77247, -84.78565, 41.76068],
    fields: {
      owner: null,
      parcelId: "state_parcel_id",
      acres: null,
      address: "prop_add",
      county: "tax_county",
    },
    note: null,
  },
  {
    // Delaware State Parcels 2.0
    // https://enterprise.firstmap.delaware.gov/arcgis/rest/services/PlanningCadastre/DE_StateParcels/MapServer/0
    state: "DE",
    name: "Delaware State Parcels 2.0",
    url: "https://enterprise.firstmap.delaware.gov/arcgis/rest/services/PlanningCadastre/DE_StateParcels/MapServer/0",
    page: "https://www.arcgis.com/home/item.html?id=07c0da8c59a64735aab71bf38dacf393",
    bbox: [-75.78901, 38.45075, -75.04944, 39.83954],
    fields: {
      owner: null,
      parcelId: "PIN",
      acres: "ACRES",
      address: null,
      county: "COUNTY",
    },
    note: null,
  },
  {
    // Virginia Parcels (Map Service)
    // https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/MapServer/0
    state: "VA",
    name: "Virginia Parcels (Map Service)",
    url: "https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/MapServer/0",
    page: "https://www.arcgis.com/home/item.html?id=d0945119ac1d44398b662c21f74d8080",
    bbox: [-83.67542, 36.53738, -75.23945, 39.46403],
    fields: {
      owner: null,
      parcelId: "PARCELID",
      acres: null,
      address: null,
      county: "LOCALITY",
    },
    note: null,
  },
  {
    // Current Parcels
    // https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0
    state: "WA",
    name: "Current Parcels",
    url: "https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=2b603a599a0842a3b2284c04c8927f35",
    bbox: [-124.92672, 45.4856, -116.71092, 49.04933],
    fields: {
      owner: null,
      parcelId: "PARCEL_ID_NR",
      acres: null,
      address: "SITUS_ADDRESS",
      county: "COUNTY_NM",
    },
    note: null,
  },
  {
    // Ohio Statewide Parcels Public View
    // https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0
    state: "OH",
    name: "Ohio Statewide Parcels Public View",
    url: "https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=26ab5fad8d5d4258a7492a14de83bc0e",
    bbox: [-84.91891, 38.37998, -80.47957, 41.99351],
    fields: {
      owner: null,
      parcelId: "StateParcelID",
      acres: "LandArea",
      address: "SitusAddressAll",
      county: "County",
    },
    note: "Land area units are not stated by the publisher.",
  },
  {
    // California Statewide Parcels Public View
    // https://bz1uwWPKUInZBK94.svcs5.arcgis.com/bz1uwWPKUInZBK94/arcgis/rest/services/CA_Statewide_Parcels_Public_view/FeatureServer/0
    state: "CA",
    name: "California Statewide Parcels Public View",
    url: "https://bz1uwWPKUInZBK94.svcs5.arcgis.com/bz1uwWPKUInZBK94/arcgis/rest/services/CA_Statewide_Parcels_Public_view/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=2061fbc963464c5198ec064100802624",
    bbox: [-125.00229, 32.38023, -113.34932, 42.14545],
    fields: {
      owner: null,
      parcelId: "PARCEL_APN",
      acres: null,
      address: "SITE_ADDR",
      county: "COUNTYNAME",
    },
    note: null,
  },
  {
    // NDGISHUB Parcels
    // https://services1.arcgis.com/GOcSXpzwBHyk2nog/arcgis/rest/services/NDGISHUB_Parcels/FeatureServer/0
    state: "ND",
    name: "NDGISHUB Parcels",
    url: "https://services1.arcgis.com/GOcSXpzwBHyk2nog/arcgis/rest/services/NDGISHUB_Parcels/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=ac6da1176038457db16e8debe3f1abaf",
    bbox: [-104.04909, 45.93498, -96.55453, 49.0005],
    fields: {
      owner: null,
      parcelId: "UniqueGISID",
      acres: "CalculatedAcres",
      address: null,
      county: "CountyName",
    },
    note: null,
  },
];
