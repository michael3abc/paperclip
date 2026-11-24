import express from "express";
import request from "supertest";
import pino from "pino";
import { expect, it } from "vitest";
import { createHttpLogger } from "../middleware/logger.js";

it("never logs terminal-like input from rejected HTTP requests", async () => {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: line => { lines.push(line); } });
  const app = express(); app.use(express.json()); app.use(createHttpLogger(logger));
  app.post("/api/companies/company/host-terminals/local/sessions", (_req, res) => res.status(400).json({ error: "Only the registered host ID is accepted" }));
  await request(app).post("/api/companies/company/host-terminals/local/sessions")
    .send({ data: "fake-terminal-private-input" });
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.join("\n")).not.toContain("fake-terminal-private-input");
});
