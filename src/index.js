import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/+$/, "");
const PORT = parseInt(process.env.PORT || "3000", 10);

const BLOCKED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

function buildHeaders(reqHeaders) {
  const out = {};
  let clientIp = null;

  for (const rawKey of Object.keys(reqHeaders)) {
    const k = rawKey.toLowerCase();
    const v = reqHeaders[rawKey];

    if (BLOCKED_HEADERS.has(k)) continue;

    if (k === "x-real-ip") {
      clientIp = v;
      continue;
    }
    if (k === "x-forwarded-for") {
      if (!clientIp) clientIp = v;
      continue;
    }

    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }

  if (clientIp) out["x-forwarded-for"] = clientIp;
  return out;
}

function hasRequestBody(method) {
  return method !== "GET" && method !== "HEAD";
}

if (!TARGET_BASE) {
  console.error("ERROR: TARGET_DOMAIN env var is not set");
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    const targetUrl = TARGET_BASE + req.url;
    const method = req.method;
    const headers = buildHeaders(req.headers);

    const fetchOpts = { method, headers, redirect: "manual" };

    if (hasRequestBody(method)) {
      fetchOpts.body = Readable.toWeb(req);
      fetchOpts.duplex = "half";
    }

    const upstream = await fetch(targetUrl, fetchOpts);

    res.statusCode = upstream.status;

    for (const [k, v] of upstream.headers) {
      if (k.toLowerCase() === "transfer-encoding") continue;
      try {
        res.setHeader(k, v);
      } catch {
        // skip unwritable headers
      }
    }

    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("[relay] error:", err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Bad Gateway: upstream unreachable");
    }
  }
});

server.listen(PORT, () => {
  console.log(`[relay] running on port ${PORT}`);
  console.log(`[relay] forwarding to: ${TARGET_BASE}`);
});
