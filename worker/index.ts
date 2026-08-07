import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { createAuthBroker } from "../src/handler";

export interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  ISSUER_URL?: string;
  JWT_PRIVATE_JWK?: string;
  JWT_KEY_ID?: string;
  ADMIN_EMAILS?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
  AUTH_CODE_TTL_SECONDS?: string;
  DEVICE_CODE_TTL_SECONDS?: string;
  DEVICE_POLL_INTERVAL_SECONDS?: string;
  REFRESH_TOKEN_TTL_SECONDS?: string;
  ALLOWED_CORS_ORIGINS?: string;
  NODE_ENV?: string;
  TEST_AUTH_EMAIL?: string;
  TEST_AUTH_FULL_NAME?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        allowedWidths,
      );
    }

    const broker = await createAuthBroker(env, ctx);
    const brokerResponse = await broker.fetch(request);
    if (brokerResponse) return brokerResponse;

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
