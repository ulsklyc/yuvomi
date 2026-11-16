/**
 * The Express surface used by the Paperless routers and their HTTP fixtures.
 * Express is CommonJS and the project does not ship its type declarations. Keep
 * this boundary structural and local, rather than changing every legacy router's
 * inferred types by introducing global Express declarations.
 */
import { createRequire } from 'node:module';
import type { Server } from 'node:http';

export type Request = {
  authUserId?: number | null;
  authRole?: string;
  authMethod?: string;
  session?: { userId?: number; role?: string };
  sessionModuleAccess?: Record<string, 'none' | 'read'> | null;
  params: Record<string, string>;
  query: Record<string, unknown>;
  // Express's JSON parser accepts arbitrary JSON; each route validates its fields.
  body: any;
  path: string;
  method: string;
  get(name: string): string | undefined;
};
export type Response = {
  status(code: number): Response;
  json(body: unknown): Response;
  send: (body: unknown) => Response;
  sendStatus(code: number): Response;
  end(): Response;
  set(name: string, value: string): Response;
  get(name: string): string | undefined;
  attachment(name: string): Response;
  type(value: string): Response;
};
type Next = (err?: unknown) => void;
type Handler = (req: Request, res: Response, next: Next) => unknown;
export type ErrorHandler = (err: unknown, req: Request, res: Response, next: Next) => unknown;
type Router = {
  stack: {route?: {path: unknown, methods: Record<string, boolean>}}[];
  use(handler: Handler | Router): Router;
  use(handler: ErrorHandler): Router;
  use(path: string, handler: Handler | Router): Router;
  get(path: string, ...handlers: Handler[]): Router;
  post(path: string, ...handlers: Handler[]): Router;
  patch(path: string, ...handlers: Handler[]): Router;
  put(path: string, ...handlers: Handler[]): Router;
  delete(path: string, ...handlers: Handler[]): Router;
};
type Application = Router & { listen(port: number, host: string): Server };
type Express = { (): Application; Router(): Router; json(): Handler };
const express: Express = createRequire(import.meta.url)('express');
export default express;
