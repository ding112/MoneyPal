import { cp } from "node:fs/promises";
await cp(new URL("../src/core", import.meta.url),new URL("../dist/src/core",import.meta.url),{recursive:true});
await cp(new URL("../src/core-provenance.json", import.meta.url),new URL("../dist/src/core-provenance.json",import.meta.url));
