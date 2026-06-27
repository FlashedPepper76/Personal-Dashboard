// GET /api/fun-fact
// Asks Gemini for one fresh fun fact every time it's called (the frontend
// calls this once per dashboard open — see loadFunFact() in index.html).
// fun_facts used to be "one cached row per day" (like daily_digest); it's
// now a history log instead — every generated fact gets inserted, and the
// last ~15 are fed back into the prompt so Gemini doesn't repeat itself
// across opens on the same day.
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

// Used if GEMINI_API_KEY isn't set, or the Gemini call fails — so the card
// never just shows an error where a fact should be.
const FALLBACK_FACTS = [
  { text: 'Octopuses have three hearts. Two pump blood to the gills, and the third pumps it to the rest of the body — but that third heart actually stops when the octopus swims.', category: 'animals' },
  { text: 'A day on Venus is longer than its year — it rotates so slowly that one spin takes 243 Earth days, while it orbits the Sun in 225.', category: 'space' },
  { text: 'Honey found in ancient Egyptian tombs is still technically edible thousands of years later, thanks to its low moisture and natural acidity.', category: 'history' }
];

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Use GET' });
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  res.setHeader('Cache-Control', 'no-store');

  const fallback = () => {
    const pick = FALLBACK_FACTS[Math.floor(Math.random() * FALLBACK_FACTS.length)];
    res.status(200).json({ text: pick.text, category: pick.category, fallback: true });
  };

  if (!process.env.GEMINI_API_KEY) {
    fallback();
    return;
  }

  try {
    const { data: recent } = await supabase
      .from('fun_facts')
      .select('fact_text')
      .order('created_at', { ascending: false })
      .limit(15);
    const recentTexts = (recent || []).map((r) => r.fact_text);

    const prompt = `Give Carter one fresh, surprising, true fun fact for his personal dashboard. 1-2 sentences, plain prose, no markdown, no preamble like "Did you know".

Pick a different topic area each time — science, history, animals, space, language, food, geography, technology, art, whatever — vary it.

${recentTexts.length ? `Don't repeat any of these (already shown recently), and avoid close variations on the same topic:\n${recentTexts.map((t) => `- ${t}`).join('\n')}` : ''}

Respond with ONLY JSON, no prose, no markdown fences:
{"text": "the fact", "category": "one short lowercase word like science, history, animals, space, language, food, geography, tech, art"}`;

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' }
    });

    const rawText = aiResponse.text || '';
    let parsed;
    try {
      parsed = JSON.parse(rawText.trim().replace(/^```json\s*|```$/g, ''));
    } catch (err) {
      console.error('[fun-fact] Could not parse Gemini response:', rawText);
      fallback();
      return;
    }

    const text = String(parsed.text || '').trim();
    const category = String(parsed.category || '').trim().toLowerCase() || null;
    if (!text) {
      fallback();
      return;
    }

    // Best-effort log for future dedup — a failed insert shouldn't stop the
    // fact from reaching the dashboard.
    const { error: insertErr } = await supabase
      .from('fun_facts')
      .insert({ fact_text: text, category });
    if (insertErr) console.error('[fun-fact] history insert failed:', insertErr.message);

    res.status(200).json({ text, category });
  } catch (err) {
    console.error('[fun-fact] Gemini call failed:', err.message);
    fallback();
  }
};
