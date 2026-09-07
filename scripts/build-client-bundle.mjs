import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

const [controller, template, styles] = await Promise.all([
  readFile("src/client.ts", "utf8"),
  readFile("src/client.bundle.template.cjs", "utf8"),
  readFile("src/client.css", "utf8"),
]);
const marker = "/*__CLIENT_RUNTIME__*/";
const styleMarker = '"__CLIENT_STYLES__"';
if (!template.includes(marker)) throw new Error("client bundle template missing runtime marker");
if (!template.includes(styleMarker)) throw new Error("client bundle template missing style marker");
const runtime = ts.transpileModule(controller, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.CommonJS } }).outputText;
const bundle = template.replace(marker, runtime).replace(styleMarker, JSON.stringify(styles));
await mkdir("dist/src", { recursive: true });
await writeFile("dist/src/client.bundle.cjs", bundle);
