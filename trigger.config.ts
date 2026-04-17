import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_vwgfedkwvnrskqxkqchy",
  runtime: "node",
  logLevel: "log",
  maxDuration: 1800,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 5000,
      maxTimeoutInMs: 30000,
      factor: 2,
    },
  },
});
