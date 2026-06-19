import { task, logger } from "@trigger.dev/sdk";

export const smokeTestClaude = task({
  id: "smoke-test-claude",
  maxDuration: 120,
  run: async () => {
    const start = Date.now();
    logger.log("Calling Anthropic API...");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        messages: [{ role: "user", content: "Say 'ok'." }],
      }),
    });

    const elapsed = Date.now() - start;
    const body = await res.text();

    logger.log(`Status: ${res.status}, took ${elapsed}ms`);
    logger.log(body);

    return { status: res.status, elapsedMs: elapsed, body };
  },
});
