import { selfTestUiUsability } from "./lib/ui-usability.mjs";

process.stdout.write(`${JSON.stringify(selfTestUiUsability())}\n`);
