import { createLogger } from '../logger.js';

const log = createLogger('SubscriptionAI');

function localRecommendations(subscriptions, baseCurrency) {
  return subscriptions
    .filter((row) => row.monthly_base !== null)
    .sort((a, b) => b.monthly_base - a.monthly_base)
    .slice(0, 3)
    .map((row) => ({
      subscription_id: row.id,
      title: row.name,
      insight: `Review this subscription: it costs ${row.monthly_base.toFixed(2)} ${baseCurrency} per month.`,
      type: 'review_high_cost',
    }));
}

function promptFor(subscriptions, baseCurrency) {
  const compact = subscriptions.map((row) => ({
    id: row.id,
    name: row.name,
    monthly_cost: row.monthly_base,
    currency: baseCurrency,
    category: row.category_name,
    enabled: row.enabled,
    next_payment_date: row.next_payment_date,
  }));
  return [
    'Analyze these household subscriptions.',
    'Return only a JSON array with at most 5 objects.',
    'Each object must contain subscription_id, title, insight, and type.',
    'Do not infer sensitive facts or recommend financial products.',
    JSON.stringify(compact),
  ].join('\n');
}

function parseRecommendations(text) {
  const match = String(text || '').match(/\[[\s\S]*\]/);
  if (!match) throw new Error('AI provider did not return a JSON array.');
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) throw new Error('AI provider response is invalid.');
  return parsed.slice(0, 5).map((item) => ({
    subscription_id: Number(item.subscription_id) || null,
    title: String(item.title || '').slice(0, 200),
    insight: String(item.insight || '').slice(0, 1000),
    type: String(item.type || 'general').slice(0, 50),
  })).filter((item) => item.insight);
}

async function openAiRecommendations(prompt) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.SUBSCRIPTION_AI_MODEL || 'gpt-5.5',
      input: prompt,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`OpenAI returned HTTP ${response.status}.`);
  const payload = await response.json();
  const text = payload.output_text
    || payload.output?.flatMap((item) => item.content || []).map((item) => item.text || '').join('\n');
  return parseRecommendations(text);
}

async function geminiRecommendations(prompt) {
  const model = process.env.SUBSCRIPTION_AI_MODEL || 'gemini-2.0-flash';
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`);
  url.searchParams.set('key', process.env.GEMINI_API_KEY);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}.`);
  const payload = await response.json();
  return parseRecommendations(payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n'));
}

async function ollamaRecommendations(prompt) {
  const base = new URL(process.env.OLLAMA_URL || 'http://ollama:11434');
  const response = await fetch(new URL('/api/generate', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.SUBSCRIPTION_AI_MODEL || 'llama3.2',
      prompt,
      stream: false,
      format: 'json',
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
  return parseRecommendations((await response.json()).response);
}

async function recommendations(subscriptions, baseCurrency) {
  const provider = String(process.env.SUBSCRIPTION_AI_PROVIDER || 'local').toLowerCase();
  if (provider === 'local') return { provider, recommendations: localRecommendations(subscriptions, baseCurrency) };
  const prompt = promptFor(subscriptions, baseCurrency);
  try {
    if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      return { provider, recommendations: await openAiRecommendations(prompt) };
    }
    if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      return { provider, recommendations: await geminiRecommendations(prompt) };
    }
    if (provider === 'ollama') {
      return { provider, recommendations: await ollamaRecommendations(prompt) };
    }
    throw new Error(`AI provider ${provider} is not configured.`);
  } catch (err) {
    log.warn(`${provider} recommendations failed: ${err.message}`);
    return {
      provider: 'local',
      fallback_from: provider,
      error: err.message,
      recommendations: localRecommendations(subscriptions, baseCurrency),
    };
  }
}

export { localRecommendations, parseRecommendations, recommendations };
