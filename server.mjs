import "dotenv/config";
import express from "express";
import path from "node:path";
import { createBatchJob, getBatchJob, listBatchJobs } from "./lib/batch_jobs.mjs";

const app = express();
const PORT = Number.parseInt(process.env.PORT || "3000", 10);

app.use(express.json({ limit: "1mb" }));
app.use("/runs", express.static(path.resolve("runs")));
app.use(express.static(path.resolve("public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasReplicateToken: Boolean((process.env.REPLICATE_API_TOKEN || "").trim()),
    hasFishApiKey: Boolean((process.env.FISH_API_KEY || "").trim())
  });
});

app.post("/api/batches", (_req, res) => {
  try {
    const job = createBatchJob({ total: 10 });
    res.status(202).json(job);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/batches", async (_req, res) => {
  try {
    const jobs = await listBatchJobs();
    res.json({ jobs });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/batches/:id", async (req, res) => {
  try {
    const job = await getBatchJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

app.listen(PORT, () => {
  console.log(`Lip-sync web app listening on port ${PORT}`);
});
