// Finite remote collector: credentials stay on the execution host. No sessions/turns.
import { homedir } from "node:os";
import path from "node:path";
import { collectHostSubscriptionQuotas } from "../services/host-subscription-quota-reader.js";

process.env.PATH = path.join(homedir(), ".local/bin") + path.delimiter + (process.env.PATH ?? "/usr/bin:/bin");
process.stdout.write(JSON.stringify(await collectHostSubscriptionQuotas(process.argv[2])));
