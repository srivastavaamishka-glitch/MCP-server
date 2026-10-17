import express from "express";
import { mockApi } from "../src/mock-api.js";

const port = Number(process.env.PORT ?? 4000);
express().use(mockApi(process.env.MOCK_TOKEN)).listen(port, () =>
  console.log(`Mock Task Manager API on http://localhost:${port}${process.env.MOCK_TOKEN ? " (bearer token required)" : ""}`));
