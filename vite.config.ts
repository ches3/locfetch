import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig(({ mode }) => ({
  plugins:
    mode === "test"
      ? [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              outboundService: (request) => {
                const url = new URL(request.url);

                if (
                  request.method !== "GET" ||
                  url.origin !== "https://trigger.macrodroid.com" ||
                  url.pathname !== "/test/locfetch"
                ) {
                  return new Response(null, { status: 404 });
                }

                return Response.json({ request_id: url.searchParams.get("request_id") });
              },
              bindings: {
                CLIENT_API_TOKEN: "test-client-api-token",
                MACRODROID_API_TOKEN: "test-macrodroid-api-token",
                MACRODROID_WEBHOOK_URL: "https://trigger.macrodroid.com/test/locfetch",
              },
            },
          }),
        ]
      : [cloudflare()],
  lint: {
    options: {
      typeCheck: true,
      typeAware: true,
    },
    rules: {
      curly: ["error", "all"],
      "typescript/no-floating-promises": "error",
      "typescript/no-unnecessary-condition": "error",
      "typescript/strict-boolean-expressions": [
        "error",
        {
          allowNumber: false,
          allowString: false,
        },
      ],
      "typescript/no-explicit-any": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/only-throw-error": "error",
      "typescript/no-dynamic-delete": "error",
      "typescript/no-misused-promises": "error",
      "typescript/use-unknown-in-catch-callback-variable": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/no-unsafe-enum-comparison": "error",
      "typescript/restrict-plus-operands": "error",
      "typescript/prefer-nullish-coalescing": "error",
      "typescript/no-empty-object-type": "error",
      "typescript/no-confusing-void-expression": "error",
      "typescript/require-await": "error",
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
  },
}));
