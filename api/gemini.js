// api/gemini.js — Vercel Serverless Function
// This runs on the SERVER. The API key never reaches the browser.
// Deploy your repo to Vercel, then add GEMINI_API_KEY in:
// Vercel Dashboard → Your Project → Settings → Environment Variables

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: API key missing' });
  }

  const { model, body } = req.body;
  if (!model || !body) {
    return res.status(400).json({ error: 'Missing model or body' });
  }

  // Only allow Gemini models (safety check)
  if (!model.startsWith('gemini-')) {
    return res.status(400).json({ error: 'Invalid model' });
  }

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
