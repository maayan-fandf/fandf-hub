/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @google-cloud/firestore pulls gRPC + protobufjs + google-gax, which
  // break when webpack-bundled for the server (dynamic requires + proto
  // assets). Mark it external so Next resolves it from node_modules at
  // runtime instead of bundling it. Without this the storage-migration
  // dual-write throws at runtime and the best-effort catch swallows it
  // silently → Firestore never written → parity drift (diagnosed
  // 2026-05-18). See docs/STORAGE_MIGRATION_HANDOFF.md §9.
  serverExternalPackages: ["@google-cloud/firestore"],

  experimental: {
    // Safety net for the middleware body-clone truncation described in
    // middleware.ts's matcher comment. The four upload routes are excluded
    // from the matcher, so they never pay for a clone at all; this raises the
    // cap for anything ELSE that might one day POST more than 10 MB through
    // middleware, so it fails loudly instead of arriving silently truncated.
    //
    // 32 MiB rather than something larger because that is Cloud Run's own
    // request ceiling — measured on prod 2026-09-06, a 33 MB upload never
    // reaches our code and comes back as Cloud Run's HTML 500 page. Allowing
    // more here would only buy a body the platform refuses to deliver.
    middlewareClientMaxBodySize: 32 * 1024 * 1024,
  },
};

export default nextConfig;
