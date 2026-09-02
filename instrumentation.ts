import type { AsyncHook, HookCallbacks } from "node:async_hooks";

/**
 * Next.js instrumentation hook — runs once per server process, before any
 * route module loads.
 *
 * Dev-only guard against a React bug in the build bundled with Next 15.5.
 * React's development-mode Flight server tracks every promise in the
 * process through `async_hooks` (the "awaited I/O" debug info behind the
 * Server Components track in React DevTools' performance panel) and, when
 * an async server component resolves, walks the recorded `previous` chain
 * RECURSIVELY (`visitAsyncNode`). That chain links every await that ran
 * anywhere in the process since the request began — nav-badge polling and
 * concurrent Sheets/Firestore reads included — so a request that runs for
 * minutes (a cold project page, an Apps Script call riding its 170s
 * ceiling) hands the walk a chain thousands of nodes deep and the render
 * dies with `RangeError: Maximum call stack size exceeded at Set.add`
 * (the `visited.add(node)` at the top of each recursive call). Seen on
 * /projects/לוריא 2026-09-02: 404s request, three unhandledRejections,
 * then the digest error; reproduced here at 3,437 recursive frames on a
 * 600KB stack. Nothing in this hub reads the DevTools track, and React has
 * since rewritten the walk iteratively upstream ("Collect the previous
 * chain iteratively instead of recursively to avoid stack overflow on deep
 * chains"), so this guard can go once Next ships a React with that change.
 *
 * Mechanism: React registers its tracker with
 * `async_hooks.createHook({ init, before, promiseResolve, destroy })` when
 * the app-page runtime is first required, which happens after this hook
 * runs. We wrap `createHook` and return an inert hook for exactly that
 * shape — four callbacks and no `after`. Nothing else in this process
 * registers such a hook (OpenTelemetry's async-hooks context manager, the
 * other common caller, always passes `after`), and production builds do
 * not contain the tracker at all, so outside `next dev` this is a no-op.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "development") return;

  // Resolved at runtime, not imported, so the edge compile of this file
  // never sees a Node builtin.
  const getBuiltin = (
    process as unknown as {
      getBuiltinModule?: (name: string) => typeof import("node:async_hooks");
    }
  ).getBuiltinModule;
  if (typeof getBuiltin !== "function") return;
  const asyncHooks = getBuiltin("async_hooks");
  const originalCreateHook = asyncHooks.createHook;

  asyncHooks.createHook = function createHook(callbacks: HookCallbacks): AsyncHook {
    const c = callbacks as Record<string, unknown>;
    const isReactAsyncDebugTracker =
      typeof c.init === "function" &&
      typeof c.before === "function" &&
      typeof c.promiseResolve === "function" &&
      typeof c.destroy === "function" &&
      c.after === undefined;
    if (!isReactAsyncDebugTracker) return originalCreateHook(callbacks);
    console.log(
      "[instrumentation] dev: React's async debug tracker left disabled (recursive visitAsyncNode overflows the stack on long requests)",
    );
    const inert: AsyncHook = {
      enable: () => inert,
      disable: () => inert,
    };
    return inert;
  };
}
