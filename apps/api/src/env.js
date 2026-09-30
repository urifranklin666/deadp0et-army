import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Loaded for its side effect by every module that reads configuration, so
// import order never decides whether .env has been applied yet.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../../.env"), quiet: true });
