import express, { Router } from "express";

interface Task { id: number; title: string; description?: string; completed: boolean }

/** In-memory Task Manager REST API matching demo/openapi.yaml. Pass a token to require `Authorization: Bearer <token>`. */
export function mockApi(token?: string): Router {
  const r = Router().use(express.json());
  const tasks: Task[] = [
    { id: 1, title: "Write README", description: "One-line npx and docker commands", completed: false },
    { id: 2, title: "Record demo video", completed: true },
  ];
  let nextId = 3;
  const find = (id: string) => tasks.findIndex((t) => t.id === Number(id));

  r.use((req, res, next) =>
    token && req.headers.authorization !== `Bearer ${token}` ? void res.status(401).json({ error: "Missing or invalid bearer token" }) : next());

  r.get("/tasks", (req, res) => {
    const { status, limit = "10" } = req.query;
    res.json(tasks.filter((t) => !status || t.completed === (status === "completed")).slice(0, Number(limit)));
  });
  r.post("/tasks", (req, res) => {
    if (typeof req.body?.title !== "string" || !req.body.title) return void res.status(400).json({ error: "`title` is required" });
    const t: Task = { id: nextId++, title: req.body.title, description: req.body.description, completed: false };
    tasks.push(t);
    res.status(201).json(t);
  });
  r.get("/tasks/:id", (req, res) => {
    const i = find(req.params.id);
    i < 0 ? res.status(404).json({ error: "Task not found" }) : res.json(tasks[i]);
  });
  r.delete("/tasks/:id", (req, res) => {
    const i = find(req.params.id);
    if (i < 0) return void res.status(404).json({ error: "Task not found" });
    tasks.splice(i, 1);
    res.status(204).end();
  });
  return r;
}
