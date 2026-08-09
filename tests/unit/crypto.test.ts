import test from "node:test";
import assert from "node:assert/strict";
import {
  base64UrlEncodeJson,
  nowSeconds,
  publicJwk,
  signJwt,
  verifyJwt,
  verifyPkceS256,
  sha256,
  type JwtClaims,
} from "../../src/crypto";

const fixedNow = 1_800_000_000;

test("signs and validates ES256 JWTs", async () => {
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
      exp: fixedNow + 60,
      iat: fixedNow,
      jti: "jti-1",
    },
    privateJwk,
    "kid-1",
  );
  const verified = await verifyJwt(token, [publicJwk(privateJwk, "kid-1")], {
    issuer: "https://issuer.example",
    audience: "client-a",
    now: fixedNow,
  });
  assert.equal(verified.header.alg, "ES256");
  assert.equal(verified.header.kid, "kid-1");
  assert.equal(verified.claims.sub, "local-user");
});

test("rejects wrong JWT algorithm, issuer, audience, and time claims", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const jwks = [publicJwk(privateJwk, "kid-1")];
  const expected = {
    issuer: "https://issuer.example",
    audience: "client-a",
    now: fixedNow,
  };
  const validClaims: JwtClaims = {
    iss: expected.issuer,
    sub: "local-user",
    aud: expected.audience,
    exp: fixedNow + 60,
    iat: fixedNow,
    nbf: fixedNow,
    jti: "jti-1",
  };

  const validToken = await signJwt(validClaims, privateJwk, "kid-1");
  const [, payload, signature] = validToken.split(".");
  const wrongAlgorithm = `${base64UrlEncodeJson({
    alg: "RS256",
    kid: "kid-1",
    typ: "JWT",
  })}.${payload}.${signature}`;
  await assert.rejects(
    verifyJwt(wrongAlgorithm, jwks, expected),
    /unsupported_algorithm/,
  );

  const invalidClaims: Array<{
    name: string;
    claims: JwtClaims;
    error: RegExp;
  }> = [
    {
      name: "issuer",
      claims: { ...validClaims, iss: "https://other-issuer.example" },
      error: /invalid_issuer/,
    },
    {
      name: "audience",
      claims: { ...validClaims, aud: "client-b" },
      error: /invalid_audience/,
    },
    {
      name: "expiration",
      claims: { ...validClaims, exp: fixedNow },
      error: /expired_token/,
    },
    {
      name: "issued-at",
      claims: { ...validClaims, iat: fixedNow + 61 },
      error: /invalid_iat/,
    },
    {
      name: "not-before",
      claims: { ...validClaims, nbf: fixedNow + 1 },
      error: /not_before/,
    },
  ];

  for (const fixture of invalidClaims) {
    const token = await signJwt(fixture.claims, privateJwk, "kid-1");
    await assert.rejects(
      verifyJwt(token, jwks, expected),
      fixture.error,
      fixture.name,
    );
  }
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
