import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_vwgfedkwvnrskqxkqchy",
  runtime: "node-24",
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
