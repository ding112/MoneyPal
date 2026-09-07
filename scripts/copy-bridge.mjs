import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const target = join(workspace, "dist", "src", "finance", "bridge.py");
await mkdir(dirname(target), { recursive: true });
await cp(join(workspace, "src", "finance", "bridge.py"), target);
