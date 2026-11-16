import { Hono } from "hono";
import { cors } from "hono/cors";
import { successResponse } from "@sudobility/types";
import { mockFirebaseAuthMiddleware, type MockFirebaseUser, testUser } from "./mock-auth";
import { service, mountShaperouterRoutes } from "../../src/service";

/**
 * Create a test app with mocked Firebase auth
 * @param mockUser - Mock Firebase user for authentication
 * @param testUserId - Internal user UUID (from users table)
 */
export function createTestApp(mockUser: MockFirebaseUser = testUser, testUserId?: string) {
  const app = new Hono();

  // Middleware
  app.use("*", cors());

  // Health check
  app.get("/", c => {
    return c.json(
      successResponse({
        name: "ShapeRouter API",
        version: "1.0.0",
        status: "healthy",
      })
    );
  });

  // Same route tree as production, with the auth middleware mocked
  app.route(
    "/api/v1",
    service.buildRoutes({
      authMiddleware: mockFirebaseAuthMiddleware(mockUser, testUserId),
      mountAdmin: mountShaperouterRoutes,
    })
  );

  return app;
}

/**
 * API response type for tests
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Create a test request helper
 */
export function createTestRequest(
  app: Hono,
  method: string,
  path: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
) {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  };

  if (options.body) {
    init.body = JSON.stringify(options.body);
  }

  return app.request(url, init);
}

/**
 * Helper to parse JSON response with proper typing
 */
export async function parseJson<T = unknown>(res: Response): Promise<ApiResponse<T>> {
  return (await res.json()) as ApiResponse<T>;
}

export { testUser };
