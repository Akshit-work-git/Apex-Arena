import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [template, html, css, js, manifest] = await Promise.all([
  readFile(resolve(root, "worker/index.js"), "utf8"),
  readFile(resolve(root, "web/index.html"), "utf8"),
  readFile(resolve(root, "web/styles.css"), "utf8"),
  readFile(resolve(root, "web/app.js"), "utf8"),
  readFile(resolve(root, ".openai/hosting.json"), "utf8"),
]);

const bundledHtml = html
  .replace('<link rel="stylesheet" href="./styles.css" />', `<style>${css}</style>`)
  .replace('<script src="./app.js"></script>', `<script>${js.replaceAll("</script", "<\\/script")}</script>`);

const output = template
  .replace('"__INDEX_HTML__"', JSON.stringify(bundledHtml))
  .replace('"__STYLES_CSS__"', JSON.stringify(css))
  .replace('"__APP_JS__"', JSON.stringify(js));

const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await mkdir(resolve(dist, ".openai"), { recursive: true });
await writeFile(resolve(dist, "server/index.js"), output);
await writeFile(resolve(dist, ".openai/hosting.json"), manifest);
console.log("Built Apex Arena Worker artifact");
