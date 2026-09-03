import type { Period } from "../analysis/run";

// Seasonal climate at the area of interest, so the pre and post windows can be
// placed at matching points of the year.
//
// A pre-post delta is only a measure of disturbance if the two composites were
// taken at the same point in the seasonal cycle of leaf greenness and sunlight.
// The SOP warns about this in words. This module puts the cycle on screen, as
// daily air temperature, sunlight, rain and snow at the site for every year the
// reporting periods touch, with the windows drawn over the top, so a mismatch
// is seen rather than remembered.
//
// The data is NASA POWER, the agency's daily surface climate service built on
// the MERRA-2 reanalysis. It answers anonymous requests with CORS, needs no
// key, and has served daily values since 1981. The grid is coarse, half a
// degree of latitude by five eighths of a degree of longitude, so what comes
// back is the climate of the district, not the weather at the plot. That is
// the right resolution for the question asked here, which is about the timing
// of the season rather than any one day's conditions.

export const POWER_HOST = "power.larc.nasa.gov";

const POWER_DAILY = `https://${POWER_HOST}/api/temporal/daily/point`;

export const POWER_ATTRIBUTION =
  "NASA POWER, daily surface climate from the MERRA-2 reanalysis, NASA Langley Research Center";

/** The value POWER writes where it has no observation. */
const FILL = -999;

/** One daily record. Missing values are null rather than the fill value. */
export interface ClimateDay {
  /** ISO date. */
  date: string;
  /** Mean air temperature at two metres, degrees Celsius. */
  tMean: number | null;
  tMax: number | null;
  tMin: number | null;
  /** Precipitation, millimetres over the day. */
  rain: number | null;
  /** All-sky shortwave irradiance at the surface, megajoules per square metre per day. */
  sun: number | null;
  /** Snow depth, centimetres. */
  snow: number | null;
}

export interface ClimateSeries {
  latitude: number;
  longitude: number;
  /** Ground elevation POWER reports for the grid cell, metres, if given. */
  elevation: number | null;
  /** First and last dates asked for, ISO. */
  start: string;
  end: string;
  /** Every day from start to end in order, missing days included as nulls. */
  days: ClimateDay[];
  /** Last date carrying a real temperature, ISO, or null if none did. */
  lastObserved: string | null;
  fetchedAt: number;
}

/**
 * How many years of history to draw behind the reporting period years, as the
 * reference the period years are compared with. Ten is the shortest run over
 * which a mean seasonal curve stops moving with any one year.
 */
export const REFERENCE_YEARS = 10;

/**
 * Length of the moving window the daily temperature and sunlight are smoothed
 * over. Seven days removes the day-to-day weather and leaves the season, which
 * is the signal the windows are matched against.
 */
export const SMOOTHING_DAYS = 7;

/**
 * Rain is summed over the previous four weeks rather than smoothed, because
 * what leaf greenness responds to is the water that has arrived recently, not
 * the rain on the day.
 */
export const RAIN_SUM_DAYS = 28;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function keyFromIso(iso: string): string {
  return iso.replace(/-/g, "");
}

function readValue(table: Record<string, number> | undefined, key: string): number | null {
  const value = table?.[key];
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value === FILL) return null;
  return value;
}

/** Every ISO date from start to end inclusive, in UTC arithmetic. */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * The years the reporting periods touch, and the range to fetch: ten years of
 * reference before the earliest, through the end of the latest.
 */
export function climateRange(periods: Period[]): { years: number[]; start: string; end: string } {
  const years = new Set<number>();
  for (const period of periods) {
    for (const date of [period.preStart, period.preEnd, period.postStart, period.postEnd]) {
      const year = Number.parseInt(date.slice(0, 4), 10);
      if (Number.isFinite(year)) years.add(year);
    }
  }
  const sorted = [...years].sort((a, b) => a - b);
  if (sorted.length === 0) {
    const thisYear = new Date().getUTCFullYear();
    sorted.push(thisYear);
  }
  const first = sorted[0] - REFERENCE_YEARS;
  const last = sorted[sorted.length - 1];
  // POWER lags the present by a few days and rejects a future end date, so
  // the request never runs past today.
  const today = new Date().toISOString().slice(0, 10);
  const end = `${last}-12-31` < today ? `${last}-12-31` : today;
  return { years: sorted, start: `${first}-01-01`, end };
}

/**
 * The centre of a bounding box, which is where POWER is asked. The grid cell
 * is fifty kilometres across, so anywhere inside a project boundary returns
 * the same cell for all but the largest projects.
 */
export function centreOf(bbox: [number, number, number, number]): {
  longitude: number;
  latitude: number;
} {
  return {
    longitude: (bbox[0] + bbox[2]) / 2,
    latitude: (bbox[1] + bbox[3]) / 2,
  };
}

/** A key that changes only when a new request is worth making. */
export function climateKey(
  longitude: number,
  latitude: number,
  start: string,
  end: string,
): string {
  return `${longitude.toFixed(2)},${latitude.toFixed(2)},${start},${end}`;
}

interface PowerResponse {
  geometry?: { coordinates?: number[] };
  properties?: { parameter?: Record<string, Record<string, number>> };
  messages?: string[];
}

export async function fetchClimate(
  longitude: number,
  latitude: number,
  start: string,
  end: string,
  signal?: AbortSignal,
): Promise<ClimateSeries> {
  const url = new URL(POWER_DAILY);
  url.searchParams.set(
    "parameters",
    "T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,ALLSKY_SFC_SW_DWN,SNODP",
  );
  url.searchParams.set("community", "AG");
  url.searchParams.set("longitude", longitude.toFixed(4));
  url.searchParams.set("latitude", latitude.toFixed(4));
  url.searchParams.set("start", keyFromIso(start));
  url.searchParams.set("end", keyFromIso(end));
  url.searchParams.set("format", "JSON");

  const response = await fetch(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(
      `NASA POWER answered ${response.status} ${response.statusText} for the climate request`,
    );
  }
  const body = (await response.json()) as PowerResponse;
  const table = body.properties?.parameter;
  if (!table) {
    const detail = body.messages?.join(" ") || "no parameter table in the response";
    throw new Error(`NASA POWER returned no climate data: ${detail}`);
  }

  const days: ClimateDay[] = eachDay(start, end).map((date) => {
    const key = keyFromIso(date);
    return {
      date,
      tMean: readValue(table.T2M, key),
      tMax: readValue(table.T2M_MAX, key),
      tMin: readValue(table.T2M_MIN, key),
      rain: readValue(table.PRECTOTCORR, key),
      sun: readValue(table.ALLSKY_SFC_SW_DWN, key),
      snow: readValue(table.SNODP, key),
    };
  });

  let lastObserved: string | null = null;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].tMean !== null) {
      lastObserved = days[i].date;
      break;
    }
  }

  const coords = body.geometry?.coordinates;
  return {
    latitude,
    longitude,
    elevation: coords && coords.length > 2 && Number.isFinite(coords[2]) ? coords[2] : null,
    start,
    end,
    days,
    lastObserved,
    fetchedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Derived series

/**
 * Position of a date on a January to December axis, 0 to 365, with every
 * month-day landing on the same slot whatever the year. Built on a leap-year
 * calendar so 29 February has a slot; in other years that slot is simply left
 * empty and the line is drawn across it.
 */
export function dayOfYearSlot(iso: string): number {
  const month = Number.parseInt(iso.slice(5, 7), 10);
  const day = Number.parseInt(iso.slice(8, 10), 10);
  const cumulative = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  return cumulative[month - 1] + day - 1;
}

export const SLOTS_PER_YEAR = 366;

/** Month starts on the slot axis, for ticks. */
export const MONTH_SLOTS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

export type Metric = "tMean" | "sun" | "rain" | "snow";

/**
 * Moving mean of a metric over the previous `width` days, centred, or the
 * moving sum for rain over the previous `width` days. Nulls are skipped, and a
 * window with fewer than half its days present is itself null, so a gap in
 * the record shows as a gap rather than as a value.
 */
export function smooth(
  days: ClimateDay[],
  metric: Metric,
  width: number,
  mode: "mean" | "sum",
): Array<number | null> {
  const out: Array<number | null> = new Array(days.length).fill(null);
  const half = Math.floor(width / 2);
  for (let i = 0; i < days.length; i += 1) {
    // Rain looks back, the others look around.
    const from = mode === "sum" ? i - width + 1 : i - half;
    const to = mode === "sum" ? i : i + half;
    let total = 0;
    let count = 0;
    for (let j = Math.max(0, from); j <= Math.min(days.length - 1, to); j += 1) {
      const value = days[j][metric];
      if (value === null) continue;
      total += value;
      count += 1;
    }
    if (count < Math.ceil(width / 2)) continue;
    out[i] = mode === "sum" ? total : total / count;
  }
  return out;
}

/** One line on a chart: a year's values placed on the slot axis. */
export interface YearLine {
  year: number;
  /** Indexed by slot, 0 to 365. */
  values: Array<number | null>;
}

/** The smoothed metric split by year on the slot axis. */
export function linesByYear(
  days: ClimateDay[],
  smoothed: Array<number | null>,
  years: number[],
): YearLine[] {
  const wanted = new Set(years);
  const lines = new Map<number, Array<number | null>>();
  for (let i = 0; i < days.length; i += 1) {
    const year = Number.parseInt(days[i].date.slice(0, 4), 10);
    if (!wanted.has(year)) continue;
    let line = lines.get(year);
    if (!line) {
      line = new Array(SLOTS_PER_YEAR).fill(null);
      lines.set(year, line);
    }
    line[dayOfYearSlot(days[i].date)] = smoothed[i];
  }
  return years
    .filter((year) => lines.has(year))
    .map((year) => ({ year, values: lines.get(year) as Array<number | null> }));
}

/**
 * The mean over every fetched year, slot by slot, of the smoothed metric. This
 * is the reference curve the period years are read against.
 */
export function referenceLine(
  days: ClimateDay[],
  smoothed: Array<number | null>,
): Array<number | null> {
  const totals = new Array<number>(SLOTS_PER_YEAR).fill(0);
  const counts = new Array<number>(SLOTS_PER_YEAR).fill(0);
  for (let i = 0; i < days.length; i += 1) {
    const value = smoothed[i];
    if (value === null) continue;
    const slot = dayOfYearSlot(days[i].date);
    totals[slot] += value;
    counts[slot] += 1;
  }
  return totals.map((total, slot) => (counts[slot] >= 2 ? total / counts[slot] : null));
}

// ---------------------------------------------------------------------------
// Window statistics

export interface WindowClimate {
  /** ISO start and end of the window, inclusive. */
  start: string;
  end: string;
  /** Days in the window with a temperature, and days in the window. */
  observed: number;
  length: number;
  tMean: number | null;
  sun: number | null;
  /** Total rain over the window, millimetres. */
  rain: number | null;
  /** Mean snow depth over the window, centimetres. */
  snow: number | null;
  /** Days in the window with any snow on the ground. */
  snowDays: number;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** What the climate did inside one composite window. */
export function windowClimate(
  series: ClimateSeries,
  start: string,
  end: string,
): WindowClimate {
  const inside = series.days.filter((day) => day.date >= start && day.date <= end);
  const present = (key: Metric): number[] =>
    inside
      .map((day) => day[key])
      .filter((value): value is number => typeof value === "number");
  const rain = present("rain");
  const snow = present("snow");
  return {
    start,
    end,
    observed: present("tMean").length,
    length: eachDay(start, end).length,
    tMean: mean(present("tMean")),
    sun: mean(present("sun")),
    rain: rain.length > 0 ? rain.reduce((a, b) => a + b, 0) : null,
    snow: mean(snow),
    snowDays: snow.filter((depth) => depth > 0).length,
  };
}

export interface PeriodClimate {
  periodId: string;
  pre: WindowClimate;
  post: WindowClimate;
}

export function periodClimates(series: ClimateSeries, periods: Period[]): PeriodClimate[] {
  return periods.map((period) => ({
    periodId: period.id,
    pre: windowClimate(series, period.preStart, period.preEnd),
    post: windowClimate(series, period.postStart, period.postEnd),
  }));
}

/** The distinct month-day spans the windows cover, for shading. */
export function windowSpans(
  periods: Period[],
): Array<{ label: string; from: number; to: number }> {
  const seen = new Map<string, { label: string; from: number; to: number }>();
  for (const period of periods) {
    for (const [label, start, end] of [
      ["pre", period.preStart, period.preEnd],
      ["post", period.postStart, period.postEnd],
    ] as const) {
      const from = dayOfYearSlot(start);
      const to = dayOfYearSlot(end);
      const key = `${from}-${to}`;
      const held = seen.get(key);
      if (held) {
        if (!held.label.includes(label)) held.label = `${held.label} and ${label}`;
      } else {
        seen.set(key, { label, from, to });
      }
    }
  }
  return [...seen.values()];
}

/** Whether any day in the record had snow on the ground. */
export function hasSnow(series: ClimateSeries): boolean {
  return series.days.some((day) => (day.snow ?? 0) > 0);
}

export function formatMonthDay(slot: number): string {
  let month = 0;
  while (month < 11 && MONTH_SLOTS[month + 1] <= slot) month += 1;
  return `${pad(month + 1)}-${pad(slot - MONTH_SLOTS[month] + 1)}`;
}
