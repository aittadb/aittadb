import { publicJwk } from "../src/crypto";

const keyPair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
const kid = crypto.randomUUID();

console.log(
  JSON.stringify(
    {
      JWT_KEY_ID: kid,
      JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
      public_jwk: publicJwk(privateJwk, kid),
    },
    null,
    2,
  ),
);
