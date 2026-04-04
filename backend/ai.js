const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

async function getAIResponse(problem, category) {
  if (!ANTHROPIC_API_KEY) return getFallbackResponse(category);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: `You are a helpful anonymous advisor. Keep response under 100 words. Be direct and practical. Category: ${category}`,
        messages: [{ role: 'user', content: `Problem: "${problem}". Give brief helpful response.` }]
      })
    });
    if (!response.ok) return getFallbackResponse(category);
    const data = await response.json();
    return data.content?.[0]?.text || getFallbackResponse(category);
  } catch (err) {
    return getFallbackResponse(category);
  }
}

function getFallbackResponse(category) {
  const responses = {
    'Mental Health': "What you feel is valid. Take one small step today — even 5 minutes outside counts. You are not alone. 💙",
    'Finance': "List every expense first — clarity reduces anxiety. Then cut the one biggest cost. Small steps add up fast.",
    'Relationships': "Write down exactly what you need before any conversation. Clear needs lead to clearer solutions.",
    'Career': "List 3 skills you have that someone would pay for. One genuine connection changes everything.",
    'Tech': "Break it into the smallest piece and solve just that. Share the exact error — that is where the answer lives.",
    'Studies': "25 minutes focused, 5 minutes break. Teach it to an imaginary student — if you can explain it, you know it.",
    'General': "Break it into the smallest first step. Not the solution — just the first step. Progress follows."
  };
  return responses[category] || responses['General'];
}

function calculateTrendScore(votes, replies, ageMinutes) {
  const engagement = (votes * 2) + (replies * 3);
  const decay = Math.pow(ageMinutes + 2, 1.5);
  return engagement / decay;
}

module.exports = { getAIResponse, calculateTrendScore };
