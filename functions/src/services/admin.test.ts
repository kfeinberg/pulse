import assert from "node:assert/strict";
import test from "node:test";
import { authorizeAdminHeader, isAdminToken } from "./admin.js";

const ADMIN = { email: "kalli.feinberg@gmail.com", email_verified: true };
test("manual extraction accepts only a verified administrator ID token", async () => {
  let calls = 0;
  const verify = async (token: string) => { calls++; assert.equal(token, "fixture-token"); return ADMIN; };
  assert.equal(await authorizeAdminHeader(undefined, verify), false);
  assert.equal(await authorizeAdminHeader("fixture-token", verify), false);
  assert.equal(calls, 0);
  assert.equal(await authorizeAdminHeader("Bearer fixture-token", verify), true);
  assert.equal(await authorizeAdminHeader("Bearer fixture-token", async () => ({ ...ADMIN, email_verified: false })), false);
  assert.equal(await authorizeAdminHeader("Bearer fixture-token", async () => ({ email: "someone@example.invalid", email_verified: true })), false);
  assert.equal(await authorizeAdminHeader("Bearer forged", async () => { throw new Error("invalid signature"); }), false);
  assert.equal(isAdminToken(undefined), false);
});
