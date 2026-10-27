import http from "node:http";
import worker from "../dist/server/index.js";

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`http://127.0.0.1:4174${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  try {
    const response = await worker.fetch(request, {}, { waitUntil() {} });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error?.stack || error));
  }
});
server.listen(4174, "127.0.0.1", () => console.log("http://127.0.0.1:4174"));
