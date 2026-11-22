// career-ops promises no telemetry; this covers dev, build and start alike.
process.env.NEXT_TELEMETRY_DISABLED = "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Automatic AGENTS.md generation on next dev triggers HMR reload loops.
  agentRules: false,
  // The repo root has its own lockfile, so pin Turbopack's root to this app.
  turbopack: { root: import.meta.dirname },
  // next dev serves its scripts only to localhost unless told otherwise, so a
  // page opened at 127.0.0.1 never hydrates and stays on "Loading…".
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
