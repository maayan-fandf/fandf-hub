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
};

export default nextConfig;
