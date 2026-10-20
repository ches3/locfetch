import { Temporal } from "@js-temporal/polyfill";
import * as v from "valibot";

const numberInput = v.pipe(
  v.union([v.number(), v.pipe(v.string(), v.trim(), v.nonEmpty())]),
  v.transform(Number),
);
const finiteNumber = v.pipe(v.number(), v.finite());
const nonnegativeNumber = v.pipe(finiteNumber, v.minValue(0));

function nullableValue<TSchema extends v.GenericSchema>(schema: TSchema) {
  return v.fallback(v.nullish(schema, null), null);
}

function normalizeTimestamp(value: string): string | null {
  try {
    return new Date(Temporal.Instant.from(value).epochMilliseconds).toISOString();
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}

export const locationSchema = v.object({
  lat: v.pipe(finiteNumber, v.minValue(-90), v.maxValue(90)),
  long: v.pipe(finiteNumber, v.minValue(-180), v.maxValue(180)),
  alt: v.nullable(finiteNumber),
  accuracy: v.nullable(nonnegativeNumber),
  speed: v.nullable(nonnegativeNumber),
  measured_at: v.pipe(
    v.string(),
    v.check((value) => normalizeTimestamp(value) === value),
  ),
});

export const callbackSchema = v.pipe(
  v.custom<unknown>((value) => !Array.isArray(value)),
  v.object({
    lat: nullableValue(v.pipe(numberInput, locationSchema.entries.lat)),
    long: nullableValue(v.pipe(numberInput, locationSchema.entries.long)),
    alt: nullableValue(v.pipe(numberInput, finiteNumber)),
    accuracy: nullableValue(v.pipe(numberInput, nonnegativeNumber)),
    speed: nullableValue(v.pipe(numberInput, nonnegativeNumber)),
    measured_at: nullableValue(v.pipe(v.string(), v.transform(normalizeTimestamp))),
  }),
);

export type Location = v.InferOutput<typeof locationSchema>;
export type CallbackLocation = v.InferOutput<typeof callbackSchema>;
export type LocationResult =
  | { ok: true; location: Location }
  | { ok: false; error: "location_unavailable" };

export function toLocationResult(location: CallbackLocation): LocationResult {
  const { lat, long, measured_at } = location;
  if (lat === null || long === null || measured_at === null) {
    return { ok: false, error: "location_unavailable" };
  }

  return { ok: true, location: { ...location, lat, long, measured_at } };
}

const CACHE_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;

export function isFresh(location: Location, now: number): boolean {
  const ageMs = now - Date.parse(location.measured_at);
  return ageMs >= -CLOCK_SKEW_MS && ageMs <= CACHE_MS;
}
