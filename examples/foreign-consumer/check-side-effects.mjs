#!/usr/bin/env node
/**
 * Naked import test: import only the session store and verify the process
 * exits on its own. Any top-level side-effect (open handle, registered
 * signal handler, provider init) would keep the event loop alive.
 */
import { createSession, readSession, listSessions } from "@harness/agent";

console.log("imported functions:", typeof createSession, typeof readSession, typeof listSessions);
console.log("exiting cleanly");
