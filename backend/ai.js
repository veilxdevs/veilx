// ════════════════════════════════════════════
// VEILX — AI Response Engine (backend/ai.js)
// Phase 2 — Step 2
// Uses Claude API to give first response on problem board
// ════════════════════════════════════════════

// ── How to get your FREE Claude API key ──
// 1. Go to console.anthropic.com
// 2. Sign up (free tier available)
// 3. Create an API key
// 4. Add it to your environment:
//    On Render.com: Dashboard → Environment → Add ANTHROPIC_API_KEY
//    Locally: create a .env file with: ANTHROPIC_API_KEY=your-key-here

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── Main AI Response Function ────────────────

async function getAIResponse(problem, category) {
  // If no API key set, return a helpful fallback
  if (!ANTHROPIC_API_KEY) {
    return getFallbackResponse(category);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Fast + cheap for quick responses
        max_tokens: 300,
        system: `You are a compassionate, practical anonymous advisor on VEILX — a privacy-first platform where people share problems openly. 

Your rules:
- Keep response under 100 words
- Be direct and helpful, not preachy  
- Give 1-2 concrete actionable steps
- Never ask for personal details
- Never recommend specific doctors/lawyers by name
- Always remind them they are anonymous and safe here
- End with one sentence of genuine encouragement
- Category context: ${category}`,
        messages: [
          {
            role: 'user',
            content: `Anonymous user posted this problem: "${problem}"\n\nGive a brief, helpful first response.`
          }
        ]
      })
    });

    if (!response.ok) {
      console.error('Claude API error:', response.status);
      return getFallbackResponse(category);
    }

    const data = await response.json();
    return data.content?.[0]?.text || getFallbackResponse(category);

  } catch (err) {
    console.error('AI response error:', err.message);
    return getFallbackResponse(category);
  }
}

// ── Fallback responses when API key not set ──
// Organized by category so they feel relevant

function getFallbackResponse(category) {
  const responses = {
    'Mental Health': [
      "What you're feeling is valid and you're not alone in this. Take one small step today — even just drinking water or stepping outside for 5 minutes counts. The fact that you shared this takes courage. 💙",
      "Acknowledging a problem is genuinely the hardest part. Be gentle with yourself right now. Try writing down 3 things that felt okay today, no matter how small. You're doing better than you think."
    ],
    'Finance': [
      "Start by listing every expense this month — just seeing it clearly reduces anxiety. Then identify the one biggest cost you could reduce. Small cuts stack up fast. You have more control than it feels right now.",
      "Financial stress is one of the heaviest kinds. First step: know exactly what's coming in vs going out. Even a rough number helps. Then tackle the smallest debt first for a quick win that builds momentum."
    ],
    'Relationships': [
      "The fact that this bothers you means you care — that's a strength, not a weakness. Before any conversation, write down exactly what you need (not what they did wrong). Clear needs lead to clearer solutions.",
      "Most relationship tension comes from unmet expectations neither side said out loud. Try saying exactly what you need, just once, directly. You might be surprised how much shifts."
    ],
    'Career': [
      "Career uncertainty feels paralyzing but it rarely is. List 3 skills you already have that someone would pay for. Then find one person in the field you want and send them a genuine question. One connection changes everything.",
      "Whatever you're facing at work — document everything, stay professional, and remember your options are wider than they feel right now. Your skills go with you wherever you go."
    ],
    'Tech': [
      "Break the problem into the smallest possible piece and solve just that. Stack Overflow and MDN docs solve 90% of tech problems. If you're stuck, share the exact error message — that's where the answer lives.",
      "Every developer hits walls. The trick is rubber duck debugging — explain the problem out loud step by step. You'll often find the answer before finishing the explanation."
    ],
    'Studies': [
      "Try the Pomodoro technique — 25 minutes focused, 5 minutes break. Your brain learns in cycles, not marathons. Also: teach the concept to an imaginary student. If you can explain it simply, you know it.",
      "Exam anxiety is real but preparation shrinks it. Make a list of everything you DON'T know yet — that list is your study plan. Crossing things off feels powerful."
    ],
    'General': [
      "You shared this openly — that alone takes strength. Take the problem and break it into the smallest possible first step. Not the solution, just the first step. Then do only that. Progress follows.",
      "Whatever you're going through, you reached out — that matters. Try writing the problem as if it happened to a friend. You'd probably be kinder and more practical with them. Apply that same advice to yourself."
    ]
  };

  const list = responses[category] || responses['General'];
  return list[Math.floor(Math.random() * list.length)];
}

// ── Trending Score Calculator ────────────────
// Used by the trending algorithm in Step 3

function calculateTrendScore(votes, replies, ageMinutes) {
  // Posts decay over time but votes and replies boost score
  // Formula: (votes * 2 + replies * 3) / (ageMinutes + 2) ^ 1.5
  const engagement = (votes * 2) + (replies * 3);
  const decay = Math.pow(ageMinutes + 2, 1.5);
  return engagement / decay;
}

module.exports = { getAIResponse, calculateTrendScore };