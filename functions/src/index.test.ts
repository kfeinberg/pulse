import assert from "node:assert/strict";
import test from "node:test";
import { pipelineGate, pipelineGeocode, pipelineWrite, replayStage, scrapeNow } from "./index.js";

test("compiled Firebase v2 workers retain private IAM, bounded retries, rate budgets and secret separation", () => {
  const workers = [pipelineGate, pipelineGeocode, pipelineWrite];
  const attempts = [5, 6, 5];
  const timeouts = [60, 300, 300];
  workers.forEach((worker, i) => {
    const endpoint = worker.__endpoint;
    assert.equal(endpoint.platform, "gcfv2");
    assert.equal(endpoint.timeoutSeconds, timeouts[i]);
    assert.equal(endpoint.taskQueueTrigger!.retryConfig!.maxAttempts, attempts[i]);
    assert.deepEqual((endpoint.taskQueueTrigger as unknown as { invoker: string[] }).invoker, ["private"]);
  });
  assert.equal(pipelineGeocode.__endpoint.taskQueueTrigger!.rateLimits!.maxConcurrentDispatches, 1);
  assert.equal(pipelineGeocode.__endpoint.taskQueueTrigger!.rateLimits!.maxDispatchesPerSecond, 1);
  assert.equal(pipelineWrite.__endpoint.taskQueueTrigger!.rateLimits!.maxConcurrentDispatches, 1);
  assert.deepEqual(pipelineGate.__endpoint.secretEnvironmentVariables, []);
  assert.deepEqual(pipelineGeocode.__endpoint.secretEnvironmentVariables, []);
  assert.deepEqual(pipelineWrite.__endpoint.secretEnvironmentVariables, [{ key: "ANTHROPIC_API_KEY" }]);
});

test("unauthenticated manual force extraction returns before any secret/provider/database work", async () => {
  let status = 0;
  let body: unknown;
  const req = { header: () => undefined, query: { force: "1" }, headers: {}, method: "GET" } as unknown as Parameters<typeof scrapeNow>[0];
  const res = { status: (code: number) => { status = code; return res; }, json: (value: unknown) => { body = value; return res; } } as unknown as Parameters<typeof scrapeNow>[1];
  await scrapeNow(req, res);
  assert.equal(status, 403);
  assert.deepEqual(body, { error: "Admin only" });
});

test("unauthenticated replay rejects before any extraction or Firestore access", async () => {
  await assert.rejects(replayStage.run({ data: { stage: "extract", source: "dice", force: true } } as Parameters<typeof replayStage.run>[0]), /Admin only/);
});
