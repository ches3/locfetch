import { vValidator } from "@hono/valibot-validator";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import { callbackSchema, toLocationResult } from "./location";

export { LocationCoordinator } from "./coordinator";

const app = new Hono<{ Bindings: Env }>();
const authErrors = {
  noAuthenticationHeader: { message: { error: "unauthorized" } },
  invalidAuthenticationHeader: { message: { error: "invalid_authentication_header" } },
  invalidToken: { message: { error: "unauthorized" } },
};

function requireToken(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.use("/location", async (c, next) => {
  if (c.req.method === "HEAD") {
    c.header("Allow", "GET");
    return c.body(null, 405);
  }

  await next();
});

app.get(
  "/location",
  (c, next) =>
    bearerAuth<{ Bindings: Env }>({
      token: requireToken(c.env.CLIENT_API_TOKEN, "CLIENT_API_TOKEN"),
      ...authErrors,
    })(c, next),
  async (c) => {
    const result = await c.env.LOCATION.getByName("phone").current();
    if (result.ok) {
      return c.json(result.location, 200);
    }

    switch (result.error) {
      case "webhook_failed":
      case "location_unavailable":
        return c.json({ error: result.error }, 502);
      case "location_timeout":
        return c.json({ error: result.error }, 504);
    }
  },
);

app.post(
  "/location/callback",
  (c, next) =>
    bearerAuth<{ Bindings: Env }>({
      token: requireToken(c.env.MACRODROID_API_TOKEN, "MACRODROID_API_TOKEN"),
      ...authErrors,
    })(c, next),
  vValidator("header", v.object({ "x-request-id": v.pipe(v.string(), v.uuid()) })),
  vValidator("json", callbackSchema),
  async (c) => {
    const { "x-request-id": id } = c.req.valid("header");
    const result = toLocationResult(c.req.valid("json"));
    const accepted = await c.env.LOCATION.getByName("phone").accept(id, result);
    if (!accepted) {
      return c.json({ accepted: false, error: "request_not_pending" }, 409);
    }

    return c.json({ accepted: true }, 200);
  },
);

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    const response = error.getResponse();
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  console.error(error);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
