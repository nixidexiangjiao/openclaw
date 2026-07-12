// Deployment entry for the central routing service. Kept separate from
// server.ts so importing the server (tests, tooling) never starts listening.
import { mainFromEnv } from "./server.js";

mainFromEnv(process.env);
