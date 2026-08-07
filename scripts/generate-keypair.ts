import { publicJwk } from "../src/crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const keyPair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
const kid = crypto.randomUUID();
const payload = {
  JWT_KEY_ID: kid,
  JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
  public_jwk: publicJwk(privateJwk, kid),
};

const outIndex = process.argv.indexOf("--out");
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null;

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
} else {
  console.log(JSON.stringify(payload, null, 2));
}
