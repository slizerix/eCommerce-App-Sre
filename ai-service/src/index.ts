import express from 'express';
import { config } from './config.js';
import { investigate } from './agent.js';

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, openai_configured: Boolean(config.openai.apiKey), model: config.openai.model });
});

// One investigation per request. Returns the final insight plus the full
// transcript so the caller can see the reasoning path (this is also what
// the README walkthrough quotes).
app.post('/investigate', async (req, res) => {
  const { question, max_iterations } = (req.body ?? {}) as { question?: string; max_iterations?: number };
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'invalid_input', message: 'body must include { question: string }' });
  }
  try {
    const result = await investigate(question, { maxIterations: max_iterations });
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: 'investigation_failed', message });
  }
});

app.listen(config.port, () => {
  console.log(`ai-service listening on :${config.port} (model=${config.openai.model})`);
});
