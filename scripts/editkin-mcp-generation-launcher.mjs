import { launchActiveMcpGeneration } from "./lib/editkin-mcp-generation-runtime.mjs";

if (process.argv.length !== 2) {
  throw new Error("Editkin MCP generation launcher does not accept runtime path arguments");
}

await launchActiveMcpGeneration();
