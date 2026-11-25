#!/usr/bin/env node
import { main } from './main.js';

// Handles left by node-pty would otherwise keep the process alive.
process.exit(await main(process.argv.slice(2)));
