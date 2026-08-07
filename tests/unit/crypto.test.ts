import test from "node:test";
import assert from "node:assert/strict";
import {
  nowSeconds,
  publicJwk,
  signJwt,
  verifyJwt,
  verifyPkceS256,
  sha256,
} from "../../src/crypto";

test("signs and validates ES256 JWTs and rejects wrong audience", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const token = await signJwt(
    {
      iss: "https://issuer.example",
      sub: "local-user",
      aud: "client-a",
      exp: nowSeconds() + 60,
      iat: nowSeconds(),
      jti: "jti-1",
    },
    privateJwk,
    "kid-1",
  );
  const verified = await verifyJwt(token, [publicJwk(privateJwk, "kid-1")], {
    issuer: "https://issuer.example",
    audience: "client-a",
    now: nowSeconds(),
  });
  assert.equal(verified.claims.sub, "local-user");
  await assert.rejects(
    verifyJwt(token, [publicJwk(privateJwk, "kid-1")], {
      issuer: "https://issuer.example",
      audience: "client-b",
      now: nowSeconds(),
    }),
  );
});

test("rejects unknown JWT key", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const token = await signJwt(
    {
      iss: "https://issuer.example",
      sub: "u",
      aud: "c",
      exp: nowSeconds() + 60,
      iat: nowSeconds(),
      jti: "j",
    },
    privateJwk,
    "kid-1",
  );
  await assert.rejects(
    verifyJwt(token, [], {
      issuer: "https://issuer.example",
      audience: "c",
      now: nowSeconds(),
    }),
    /unknown_key/,
  );
});

test("verifies PKCE S256 success and failure", async () => {
  const verifier =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  assert.equal(await verifyPkceS256(verifier, await sha256(verifier)), true);
  assert.equal(await verifyPkceS256(verifier, await sha256("wrong")), false);
});
