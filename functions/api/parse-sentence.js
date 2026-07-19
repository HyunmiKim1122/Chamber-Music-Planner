// Cloudflare Pages Function
// Route: POST /api/parse-sentence
//
// Purpose: takes the free-text "Sentence Search" query from the Chamber
// Music Planner (Korean or English) and asks Claude to translate it into
// structured search hints (composer names, ensemble, era, mood/atmosphere,
// audience level, familiarity, country) drawn ONLY from the enum lists the
// front end already uses. The API key never reaches the browser -- it lives
// in this Function's environment variable (set in the Cloudflare Pages
// dashboard: Settings -> Environment variables -> ANTHROPIC_API_KEY).
//
// If anything goes wrong (missing key, Anthropic error, malformed JSON from
// the model), this returns a JSON error object and the front end silently
// falls back to its existing keyword-based sentence search.

export async function onRequestPost({ request, env }) {
  try {
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'missing_api_key' }, 500);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body.text !== 'string' || !body.text.trim()) {
      return json({ error: 'bad_request' }, 400);
    }

    const text = body.text.slice(0, 500); // guard against huge payloads
    const composerList = Array.isArray(body.composerList) ? body.composerList.slice(0, 2000) : [];
    const options = body.options || {};

    const systemPrompt = `You are a musicology query parser for a chamber-music search tool.
The user writes a free-text search request, in Korean or English, describing what chamber-music works they want (e.g. relationships between composers, mood, era, instrumentation, difficulty for listeners).

Return ONLY a single JSON object, no prose, no markdown code fences, matching exactly this shape:
{"composers": string[], "ensemble": string|null, "era": string|null, "mood": string[], "audience": string|null, "familiarity": string|null, "country": string|null}

Rules:
- "composers": 0 to 8 composer names, copied VERBATIM (exact spelling) from the provided composerList. Include composers who are relevant given the query's context. NEVER invent a name that is not in composerList. If the query does not reference any specific composer or composer relationship, return an empty array.
- Pay close attention to the DIRECTION of any named relationship:
  - If the query asks for composers who were "inspired by", "influenced by", "students of", or otherwise came AFTER / were shaped BY a named composer X (e.g. "베토벤에게서 영감을 받은 작곡가", "composers inspired by Beethoven"), DO NOT include X himself in the result -- only the composers who received that influence.
  - If the query instead asks broadly for composers "connected to", "related to", or "associated with" X without specifying a direction (e.g. "베토벤과 연관 있는 작곡가"), you may include X himself along with contemporaries, teachers, students, or composers he influenced/was influenced by.
  - If the query explicitly asks for both X and those influenced by X (e.g. "베토벤과 그의 영향을 받은 작곡가들"), include X as well.
- "ensemble": pick the single best match from options.ensemble, or null.
- "era": pick the single best match from options.era, or null.
- "mood": 0 to 3 tags from options.atmos that best capture the requested mood/atmosphere, or an empty array.
- "audience": pick the single best match from options.audience (listener experience level implied by the query), or null.
- "familiarity": pick the single best match from options.familiarity, or null.
- "country": pick the single best match from options.country, or null.
- Never output a value that isn't in the corresponding provided list.
- If the query is unclear or unrelated to any field, leave that field null/empty rather than guessing.`;

    const userContent = JSON.stringify({ query: text, composerList, options });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return json({ error: 'anthropic_error', status: resp.status, detail }, 502);
    }

    const data = await resp.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    let raw = textBlock ? textBlock.text : '{}';
    raw = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return json({ error: 'parse_error' }, 502);
    }

    // Defensive shape-normalization before handing back to the client.
    const safe = {
      composers: Array.isArray(parsed.composers) ? parsed.composers.filter((c) => typeof c === 'string') : [],
      ensemble: typeof parsed.ensemble === 'string' ? parsed.ensemble : null,
      era: typeof parsed.era === 'string' ? parsed.era : null,
      mood: Array.isArray(parsed.mood) ? parsed.mood.filter((m) => typeof m === 'string') : [],
      audience: typeof parsed.audience === 'string' ? parsed.audience : null,
      familiarity: typeof parsed.familiarity === 'string' ? parsed.familiarity : null,
      country: typeof parsed.country === 'string' ? parsed.country : null,
    };

    return json(safe, 200);
  } catch (e) {
    return json({ error: 'server_error', detail: String(e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
