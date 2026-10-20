import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import { isFresh, locationSchema, type LocationResult } from "./location";

const WAIT_MS = 15_000;

type AcquisitionResult =
  | LocationResult
  | {
      ok: false;
      error: "webhook_failed" | "location_timeout";
    };

const pendingSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  deadline: v.pipe(v.number(), v.finite()),
});
type Pending = v.InferOutput<typeof pendingSchema>;
type Flight = Pending & {
  promise: Promise<AcquisitionResult>;
  resolve: (result: AcquisitionResult) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class LocationCoordinator extends DurableObject<Env> {
  private flight?: Flight;
  private failedRequestId?: string;

  private fail(operation: string, id: string | undefined, error: unknown): void {
    console.error(error, {
      event: "coordinator_failed",
      operation,
      request_id: id,
    });

    const flight = this.flight;
    if (flight !== undefined && flight.id === id) {
      clearTimeout(flight.timer);
      this.flight = undefined;
      flight.reject(error);
    }
  }

  private async read<TSchema extends v.GenericSchema>(
    key: string,
    schema: TSchema,
    storage: Pick<DurableObjectStorage, "get"> = this.ctx.storage,
  ): Promise<v.InferOutput<TSchema> | undefined> {
    const value = await storage.get<unknown>(key);
    return value === undefined ? undefined : v.parse(schema, value);
  }

  private async finish(id: string, result: AcquisitionResult): Promise<boolean> {
    const completed = await this.ctx.storage.transaction(async (storage) => {
      const pending = await this.read("pending", pendingSchema, storage);
      if (pending?.id !== id) {
        return false;
      }

      if (result.ok) {
        await storage.put("cache", result.location);
      }
      await storage.delete("pending");

      return true;
    });

    if (this.failedRequestId === id) {
      this.failedRequestId = undefined;
    }

    if (completed && this.flight?.id === id) {
      clearTimeout(this.flight.timer);
      this.flight.resolve(result);
      this.flight = undefined;
    }

    return completed;
  }

  private async reconcilePending(): Promise<void> {
    if (this.failedRequestId !== undefined) {
      await this.finish(this.failedRequestId, {
        ok: false,
        error: "webhook_failed",
      });
    }

    const pending = await this.read("pending", pendingSchema);
    if (pending && pending.deadline <= Date.now()) {
      const completed = await this.finish(pending.id, {
        ok: false,
        error: "location_timeout",
      });
      if (completed) {
        console.warn({
          event: "location_timeout",
          request_id: pending.id,
        });
      }
    }
  }

  private attach(pending: Pending): Flight {
    if (this.flight?.id === pending.id) {
      return this.flight;
    }

    const { promise, resolve, reject } = Promise.withResolvers<AcquisitionResult>();
    const timer = setTimeout(
      () => {
        this.ctx.waitUntil(
          this.reconcilePending().catch((error: unknown) => {
            this.fail("location.reconcilePending", pending.id, error);
          }),
        );
      },
      Math.max(0, pending.deadline - Date.now()),
    );
    this.flight = {
      ...pending,
      promise,
      resolve,
      reject,
      timer,
    };

    return this.flight;
  }

  async current(): Promise<AcquisitionResult> {
    let id = this.flight?.id;
    try {
      await this.reconcilePending();

      const cached = v.safeParse(locationSchema, await this.ctx.storage.get<unknown>("cache"));
      if (cached.success && isFresh(cached.output, Date.now())) {
        return {
          ok: true,
          location: cached.output,
        };
      }

      let pending = await this.read("pending", pendingSchema);
      let webhook: URL | undefined;
      if (!pending) {
        pending = {
          id: crypto.randomUUID(),
          deadline: Date.now() + WAIT_MS,
        };
        id = pending.id;

        webhook = new URL(this.env.MACRODROID_WEBHOOK_URL);
        if (webhook.protocol !== "https:" || webhook.hostname !== "trigger.macrodroid.com") {
          throw new Error("Invalid webhook URL");
        }

        webhook.searchParams.set("request_id", pending.id);
        await this.ctx.storage.put("pending", pending);
      }

      id = pending.id;
      const flight = this.attach(pending);
      if (webhook !== undefined) {
        this.ctx.waitUntil(this.dispatch(pending, webhook));
      }

      return flight.promise;
    } catch (error) {
      this.fail("location.current", id, error);
      throw error;
    }
  }

  private async dispatch(pending: Pending, url: URL): Promise<void> {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      // A network error does not prove that the device failed to receive the trigger.
      // Keep accepting the matching callback until the acquisition deadline.
      console.warn({
        event: "webhook_delivery_uncertain",
        request_id: pending.id,
        error_type: error instanceof Error ? error.name : "NonError",
      });
      return;
    }

    try {
      if (!response.ok) {
        this.failedRequestId = pending.id;
        console.warn({
          event: "webhook_failed",
          request_id: pending.id,
          status: response.status,
        });
        await this.finish(pending.id, {
          ok: false,
          error: "webhook_failed",
        });
      }
    } catch (error) {
      this.fail("location.dispatch", pending.id, error);
    }

    try {
      await response.body?.cancel();
    } catch {
      console.warn({
        event: "webhook_cleanup_failed",
        request_id: pending.id,
      });
    }
  }

  async accept(id: string, result: LocationResult): Promise<boolean> {
    try {
      await this.reconcilePending();

      return await this.finish(id, result);
    } catch (error) {
      this.fail("location.accept", id, error);
      throw error;
    }
  }
}
