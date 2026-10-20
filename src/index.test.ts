import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import app, { LocationCoordinator } from "./index";
import * as v from "valibot";

const stub = () => env.LOCATION.getByName("phone");
const clientHeaders = { Authorization: "Bearer test-client-api-token" };
const macrodroidHeaders = { Authorization: "Bearer test-macrodroid-api-token" };
const payload = (measuredAt = new Date().toISOString()) => ({
  lat: "35",
  long: "139",
  alt: "",
  accuracy: "20",
  speed: "0",
  measured_at: measuredAt,
});

function getLocation(headers: HeadersInit = clientHeaders) {
  return app.request("/location", { headers }, env);
}

function postLocation(id: string, body: unknown = payload(), headers = macrodroidHeaders) {
  return app.request(
    "/location/callback",
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Request-ID": id,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function webhookId(callIndex = 0): Promise<string> {
  return vi.waitFor(() => {
    const call = vi.mocked(fetch).mock.calls[callIndex];
    if (call === undefined) {
      throw new Error("Webhook was not called");
    }

    const input = call[0];
    const url = new URL(input instanceof Request ? input.url : input);
    return v.parse(v.pipe(v.string(), v.uuid()), url.searchParams.get("request_id"));
  });
}

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response("OK")));

  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
});

afterEach(() => vi.restoreAllMocks());

describe("Authentication", () => {
  it.each([
    ["CLIENT_API_TOKEN", "/location", "GET"],
    ["MACRODROID_API_TOKEN", "/location/callback", "POST"],
  ])(
    "returns 500 and logs the setting name when an authentication token is missing or empty (%s)",
    async (name, path, method) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      for (const value of [undefined, ""]) {
        const response = await app.request(
          path,
          { method, headers: method === "GET" ? clientHeaders : macrodroidHeaders },
          { ...env, [name]: value },
        );
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal_error" });
        expect(response.headers.get("WWW-Authenticate")).toBeNull();
      }
      expect(errorLog).toHaveBeenCalledWith(new Error(`Missing ${name}`));
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects requests with a missing token or a token for the wrong endpoint", async () => {
    const responses = [
      await getLocation({ Authorization: "" }),
      await getLocation(macrodroidHeaders),
      await postLocation(crypto.randomUUID(), payload(), clientHeaders),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(response.headers.get("WWW-Authenticate")).toMatch(/^Bearer /u);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }

    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows location requests with CLIENT_API_TOKEN and callbacks with MACRODROID_API_TOKEN", async () => {
    const request = getLocation(clientHeaders);
    const id = await webhookId();
    const response = await postLocation(id, payload(), macrodroidHeaders);

    expect(response.status).toBe(200);
    expect((await request).status).toBe(200);
  });

  it("returns 400 for a malformed authentication header", async () => {
    const headers = { Authorization: "Basic test-client-api-token" };
    const responses = [
      await getLocation(headers),
      await postLocation(crypto.randomUUID(), payload(), headers),
    ];

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(response.headers.get("WWW-Authenticate")).toContain('error="invalid_request"');
      expect(await response.json()).toEqual({ error: "invalid_authentication_header" });
    }

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GET /missing", () => {
  it("returns a JSON response with status 404 for an unknown endpoint", async () => {
    const response = await app.request("/missing", {}, env);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("HEAD /location", () => {
  it("returns 405 without requesting a location update", async () => {
    const response = await app.request(
      "/location",
      {
        method: "HEAD",
        headers: clientHeaders,
      },
      env,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(await response.text()).toBe("");
    expect(fetch).not.toHaveBeenCalled();

    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get("pending")).toBeUndefined();
    });
  });
});

describe("GET /location", () => {
  it.each(["invalid", "https://example.com/webhook"])(
    "fails without sending a request when the webhook URL is invalid (%s)",
    async (url) => {
      await runInDurableObject(stub(), async (_instance, state) => {
        const coordinator = new LocationCoordinator(state, {
          ...env,
          MACRODROID_WEBHOOK_URL: url,
        });

        await expect(coordinator.current()).rejects.toThrow();
        expect(await state.storage.get("pending")).toBeUndefined();
      });

      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("returns 500 and logs the error when the Durable Object call fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(LocationCoordinator.prototype, "current").mockRejectedValue(
      new Error("Coordinator unavailable"),
    );

    const response = await getLocation();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(errorLog.mock.calls[0]?.[0]).toMatchObject({ message: "Coordinator unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a matching callback after a webhook network error", async () => {
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Network error with private details"));

    const request = getLocation();
    const id = await webhookId();

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });

    expect((await postLocation(id)).status).toBe(200);
    expect((await request).status).toBe(200);
    expect(warningLog).toHaveBeenCalledOnce();

    expect(warningLog).toHaveBeenCalledWith({
      event: "webhook_delivery_uncertain",
      request_id: id,
      error_type: "TypeError",
    });
  });

  it("returns 502 and logs the webhook status when the webhook returns an error response", async () => {
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve(new Response("Private response details", { status: 503 })),
    );

    const response = await getLocation();

    expect(response.status).toBe(502);
    const logged: unknown = warningLog.mock.calls[0]?.[0];
    expect(logged).toMatchObject({
      event: "webhook_failed",
      status: 503,
    });
    expect(
      v.parse(v.object({ request_id: v.pipe(v.string(), v.uuid()) }), logged).request_id,
    ).toBeDefined();
  });

  it("accepts a matching callback when discarding the webhook response body fails", async () => {
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cancel = vi.fn(() => Promise.reject(new Error("Response cleanup failed")));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));

    const request = getLocation();
    const id = await webhookId();
    await vi.waitFor(() => {
      expect(warningLog).toHaveBeenCalledWith({
        event: "webhook_cleanup_failed",
        request_id: id,
      });
    });

    expect((await postLocation(id)).status).toBe(200);
    expect((await request).status).toBe(200);
  });

  it("shares a single location update across concurrent requests and returns all six callback fields", async () => {
    vi.mocked(fetch).mockRestore();
    const runtimeFetch = globalThis.fetch;
    let receivedId: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await runtimeFetch(...args);
      const body: unknown = await response.clone().json();
      receivedId = v.parse(v.object({ request_id: v.pipe(v.string(), v.uuid()) }), body).request_id;

      return response;
    });

    const first = getLocation();
    const id = await vi.waitFor(() => v.parse(v.pipe(v.string(), v.uuid()), receivedId));
    const second = getLocation();

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });

    const webhookCall = vi.mocked(fetch).mock.calls[0];
    if (webhookCall === undefined) {
      throw new Error("Webhook was not called");
    }

    const webhookInput = webhookCall[0];
    const webhook = new URL(webhookInput instanceof Request ? webhookInput.url : webhookInput);
    expect(webhook.searchParams.get("request_id")).toBe(id);
    expect((await postLocation(id)).status).toBe(200);

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers.get("Cache-Control")).toBe("no-store");

    const value = await a.json();
    expect(value).toMatchObject({
      lat: 35,
      long: 139,
      alt: null,
      accuracy: 20,
      speed: 0,
    });
    expect(await b.json()).toEqual(value);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reuses results up to 60 seconds old after the Durable Object is recreated", async () => {
    const request = getLocation();
    await postLocation(await webhookId());
    expect((await request).status).toBe(200);

    await evictDurableObject(stub());

    expect((await getLocation()).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  }, 35_000);

  it("does not reuse cached results with stale measurement timestamps, even if just received", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const cached = {
        lat: 35,
        long: 139,
        alt: null,
        accuracy: 20,
        speed: 0,
        measured_at: new Date(Date.now() - 61_000).toISOString(),
      };
      await state.storage.put("cache", cached);
    });

    const request = getLocation();
    await postLocation(await webhookId());
    expect((await request).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns 504 after 15 seconds and prevents late callbacks from completing the next request", async () => {
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const first = getLocation();
      const oldId = await webhookId();

      await runInDurableObject(stub(), async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect((await first).status).toBe(504);
      expect(warningLog).toHaveBeenCalledExactlyOnceWith({
        event: "location_timeout",
        request_id: oldId,
      });

      const next = getLocation();
      const newId = await webhookId(1);
      expect(newId).not.toBe(oldId);
      expect((await postLocation(oldId, { ...payload(), lat: "unknown" })).status).toBe(409);
      expect((await postLocation(newId)).status).toBe(200);
      expect((await next).status).toBe(200);
      expect(warningLog).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([-120_000, 120_000])(
    "returns past or future measurements but does not reuse results outside the freshness window (offset: %i ms)",
    async (offset) => {
      const request = getLocation();
      const id = await webhookId();
      const measuredAt = new Date(Date.now() + offset).toISOString();

      expect((await postLocation(id, payload(measuredAt))).status).toBe(200);
      const response = await request;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        lat: 35,
        long: 139,
        measured_at: measuredAt,
      });

      const next = getLocation();
      const newId = await webhookId(1);
      expect(newId).not.toBe(id);
      expect((await postLocation(newId)).status).toBe(200);
      expect((await next).status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
});

describe("POST /location/callback", () => {
  it("converts measurement timestamps with a UTC offset to UTC before storing and returning them", async () => {
    const request = getLocation();
    const id = await webhookId();

    expect((await postLocation(id, payload("2026-10-17T19:49:09+09:00"))).status).toBe(200);
    const response = await request;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      measured_at: "2026-10-17T10:49:09.000Z",
    });
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get("cache")).toMatchObject({
        measured_at: "2026-10-17T10:49:09.000Z",
      });
    });
  });

  it.each([
    "2026-10-17 19:49:09",
    "2026-10-17T19:49:09",
    "2026-02-30T12:00:00Z",
    "2026-10-17T19:49:09+24:00",
    "2026-10-17T19:49:09+09:60",
    "date: bad date Location unknown",
  ])(
    "accepts callbacks with invalid measurement timestamps and returns 502 to the client (%s)",
    async (value) => {
      const request = getLocation();
      const response = await postLocation(await webhookId(), payload(value));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true });
      const result = await request;
      expect(result.status).toBe(502);
      expect(await result.json()).toEqual({ error: "location_unavailable" });
    },
  );

  it("preserves the cache when location data is unavailable and requests a new update on the next request", async () => {
    const cached = {
      lat: 35,
      long: 139,
      alt: null,
      accuracy: 20,
      speed: 0,
      measured_at: new Date(Date.now() - 61_000).toISOString(),
    };
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put("cache", cached);
    });

    const request = getLocation();
    const id = await webhookId();
    const callback = await postLocation(id, {
      lat: "Location unknown",
      long: "Location unknown",
      alt: "Location unknown",
      accuracy: "Location unknown",
      speed: "Location unknown",
      measured_at: "date: bad date Location unknown",
    });
    expect(callback.status).toBe(200);
    const result = await request;
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: "location_unavailable" });
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get("cache")).toEqual(cached);
    });

    const retry = getLocation();
    const newId = await webhookId(1);
    expect(newId).not.toBe(id);
    expect((await postLocation(newId)).status).toBe(200);
    expect((await retry).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns 400 for an invalid request ID", async () => {
    const invalidId = await postLocation("invalid");
    expect(invalidId.status).toBe(400);
  });

  it.each(["{", "null", "[]"])(
    "returns 400 for malformed JSON or a non-object JSON value (%s)",
    async (body) => {
      const response = await app.request(
        "/location/callback",
        {
          method: "POST",
          headers: {
            ...macrodroidHeaders,
            "Content-Type": "application/json",
            "X-Request-ID": crypto.randomUUID(),
          },
          body,
        },
        env,
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );
});
