import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import { callbackSchema, isFresh, locationSchema } from "./location";

const input = {
  lat: "35",
  long: "139",
  alt: "30",
  accuracy: "15.6",
  speed: "0",
  measured_at: "2026-10-17T19:49:09+09:00",
};

const normalized = {
  lat: 35,
  long: 139,
  alt: 30,
  accuracy: 15.6,
  speed: 0,
  measured_at: "2026-10-17T10:49:09.000Z",
};

describe("locationSchema", () => {
  it("accepts normalized location data unchanged", () => {
    expect(v.parse(locationSchema, normalized)).toEqual(normalized);
  });

  it.each([
    { ...normalized, lat: "35" },
    { ...normalized, lat: 91 },
    { ...normalized, long: Infinity },
    { ...normalized, accuracy: "unknown" },
    { ...normalized, alt: undefined },
    { ...normalized, measured_at: input.measured_at },
  ])("rejects location data that does not match the normalized format (%j)", (value) => {
    expect(v.safeParse(locationSchema, value).success).toBe(false);
  });
});

describe("callbackSchema", () => {
  it("converts numeric strings to numbers and preserves zero values", () => {
    expect(v.parse(callbackSchema, input)).toEqual(normalized);
  });

  it("sets optional fields to null when only the three required fields are provided", () => {
    expect(
      v.parse(callbackSchema, {
        lat: input.lat,
        long: input.long,
        measured_at: input.measured_at,
      }),
    ).toEqual({
      lat: 35,
      long: 139,
      alt: null,
      accuracy: null,
      speed: null,
      measured_at: "2026-10-17T10:49:09.000Z",
    });
  });

  it("sets invalid fields to null and preserves valid fields", () => {
    expect(
      v.parse(callbackSchema, {
        ...input,
        lat: "Location unknown",
        alt: "unknown",
        accuracy: "-1",
        speed: "Infinity",
      }),
    ).toEqual({
      lat: null,
      long: 139,
      alt: null,
      accuracy: null,
      speed: null,
      measured_at: "2026-10-17T10:49:09.000Z",
    });
  });

  it("sets omitted fields to null", () => {
    expect(v.parse(callbackSchema, {})).toEqual({
      lat: null,
      long: null,
      alt: null,
      accuracy: null,
      speed: null,
      measured_at: null,
    });
  });
});

describe("isFresh()", () => {
  it("marks results older than 60 seconds as stale", () => {
    const timestamp = Date.parse(normalized.measured_at);

    expect(isFresh(normalized, timestamp + 60_000)).toBe(true);
    expect(isFresh(normalized, timestamp + 60_001)).toBe(false);
  });
});
