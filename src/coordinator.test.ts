import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as v from "valibot";

async function webhookId(callIndex: number): Promise<string> {
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

afterEach(() => vi.restoreAllMocks());

describe("LocationCoordinator", () => {
  it("requests a new location update when the cache is missing required fields", async () => {
    const coordinator = env.LOCATION.getByName("invalid-cache");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response("OK")));

    await runInDurableObject(coordinator, async (instance, state) => {
      await state.storage.deleteAll();
      await state.storage.put("cache", {
        lat: 35,
        long: 139,
        alt: null,
        accuracy: 20,
        measured_at: new Date().toISOString(),
      });

      const request = instance.current();
      const id = await webhookId(0);
      const location = {
        lat: 36,
        long: 140,
        alt: null,
        accuracy: 10,
        speed: 0,
        measured_at: new Date().toISOString(),
      };
      expect(await instance.accept(id, { ok: true, location })).toBe(true);
      expect(await request).toEqual({ ok: true, location });
      expect(await instance.current()).toEqual({ ok: true, location });
      expect(fetch).toHaveBeenCalledOnce();
    });
  });

  it("throws without sending a webhook request when reading the cache fails", async () => {
    const coordinator = env.LOCATION.getByName("cache-storage-failure");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response("OK")));

    await runInDurableObject(coordinator, async (instance, state) => {
      await state.storage.deleteAll();
      const get = state.storage.get.bind(state.storage);
      const read = vi
        .spyOn(state.storage, "get")
        .mockImplementationOnce(get)
        .mockRejectedValueOnce(new Error("Storage unavailable"));

      await expect(instance.current()).rejects.toThrow("Storage unavailable");
      expect(read).toHaveBeenNthCalledWith(2, "cache");
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("throws without sending a webhook request when saving the pending request fails", async () => {
    const coordinator = env.LOCATION.getByName("pending-storage-failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("Storage unavailable");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response("OK")));

    await runInDurableObject(coordinator, async (instance, state) => {
      await state.storage.deleteAll();
      vi.spyOn(state.storage, "put").mockRejectedValue(error);

      await expect(instance.current()).rejects.toThrow("Storage unavailable");
      expect(fetch).not.toHaveBeenCalled();
      expect(await state.storage.get("pending")).toBeUndefined();
      expect(errorLog.mock.calls[0]?.[0]).toBe(error);
      const context: unknown = errorLog.mock.calls[0]?.[1];
      expect(context).toMatchObject({
        event: "coordinator_failed",
        operation: "location.current",
      });
      expect(
        v.parse(v.object({ request_id: v.pipe(v.string(), v.uuid()) }), context).request_id,
      ).toBeDefined();
    });
  });

  it("propagates errors during timeout handling to the waiting request", async () => {
    const coordinator = env.LOCATION.getByName("timeout-storage-failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("Storage unavailable");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response("OK")));
    vi.useFakeTimers();
    try {
      await runInDurableObject(coordinator, async (instance, state) => {
        await state.storage.deleteAll();
        const request = instance.current();
        const rejected = expect(request).rejects.toThrow("Storage unavailable");
        const id = await webhookId(0);
        vi.spyOn(state.storage, "get").mockRejectedValue(error);

        await vi.advanceTimersByTimeAsync(15_000);
        await rejected;
        expect(errorLog).toHaveBeenCalledExactlyOnceWith(error, {
          event: "coordinator_failed",
          operation: "location.reconcilePending",
          request_id: id,
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates callback storage errors to both the callback handler and the waiting request", async () => {
    const coordinator = env.LOCATION.getByName("callback-storage-failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("Storage unavailable");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response("OK")));

    await runInDurableObject(coordinator, async (instance, state) => {
      await state.storage.deleteAll();
      const request = instance.current();
      const rejected = expect(request).rejects.toThrow("Storage unavailable");
      const id = await webhookId(0);
      vi.spyOn(state.storage, "transaction").mockRejectedValue(error);

      await expect(
        instance.accept(id, {
          ok: true,
          location: {
            lat: 35,
            long: 139,
            alt: null,
            accuracy: 20,
            speed: 0,
            measured_at: new Date().toISOString(),
          },
        }),
      ).rejects.toThrow("Storage unavailable");
      await rejected;
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(error, {
        event: "coordinator_failed",
        operation: "location.accept",
        request_id: id,
      });
    });
  });

  it("requests a new location update after storage recovers from an error while handling a webhook failure", async () => {
    const coordinator = env.LOCATION.getByName("webhook-recovery");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new Error("Storage unavailable");
    const webhook = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("OK")))
      .mockReturnValueOnce(webhook.promise);

    await runInDurableObject(coordinator, async (instance, state) => {
      await state.storage.deleteAll();
      const request = instance.current();
      const rejected = expect(request).rejects.toThrow("Storage unavailable");
      const id = await webhookId(0);
      let storageAvailable = false;
      const transaction = state.storage.transaction.bind(state.storage);
      vi.spyOn(state.storage, "transaction").mockImplementation((closure) =>
        storageAvailable ? transaction(closure) : Promise.reject(error),
      );

      webhook.resolve(new Response(null, { status: 503 }));
      await rejected;
      expect(errorLog).toHaveBeenCalledWith(error, {
        event: "coordinator_failed",
        operation: "location.dispatch",
        request_id: id,
      });
      await expect(instance.current()).rejects.toThrow("Storage unavailable");
      expect(fetch).toHaveBeenCalledOnce();

      storageAvailable = true;

      const retry = instance.current();
      const newId = await webhookId(1);
      expect(newId).not.toBe(id);
      const location = {
        lat: 35,
        long: 139,
        alt: null,
        accuracy: 20,
        speed: 0,
        measured_at: new Date().toISOString(),
      };
      expect(await instance.accept(id, { ok: true, location })).toBe(false);
      expect(await instance.accept(newId, { ok: true, location })).toBe(true);
      expect(await retry).toEqual({ ok: true, location });
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});
