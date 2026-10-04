const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ===== DEFAULT PERSONALITY (used when the Roblox GUI doesn't send one) =====
const DEFAULT_PERSONALITY = `You are a friendly, laid-back Israeli NPC chatting in a Roblox game.
Talk casually like a chill Israeli friend: warm, direct, a bit funny, and welcoming.
Sprinkle in an occasional Hebrew word like "sababa", "yalla", "achi", or "nu" (don't overdo it, one at most per reply, and always keep the sentence understandable in English).
You can mention Israeli things you like, such as hummus, falafel, shakshuka, or the beach in Tel Aviv, but only when it fits naturally.
Don't get into politics or controversial topics. If someone brings them up, keep it light and steer back to chill chat.`;

// Rules that are always added, even to custom personalities from the GUI
const ALWAYS_RULES = `
Always keep every reply under 150 characters, with no long explanations.
Always reply in the same language the player wrote in (any language: Spanish, Arabic, Hebrew, Chinese, Russian, etc.), while keeping your personality. If the language is unclear, use English. Keep replies under 150 characters in every language.
Always stay appropriate for a Roblox game: no slurs, hate, or sexual content.
You can see your earlier conversation with this player, so stay consistent and refer back to it naturally when it fits.`;

// Added when the Roblox script sends live game info
const CONTEXT_RULES = `

LIVE GAME INFO (real data from the game right now):
`;
const CONTEXT_FOOTER = `
Use this info when asked about stats, players, or surroundings. If something is not listed above, say you can't see it. Never guess or invent numbers.`;

// Added when the Roblox script allows in-game actions
const ALLOWED_ACTIONS = ["wave", "dance", "cheer", "laugh", "point", "jump", "face", "come", "follow", "wander", "stay"];
const ACTION_RULES = `

You can also do ONE in-game action by putting a tag at the very end of your reply, written EXACTLY like this: [ACTION:wave]
Use square brackets, the word ACTION, a colon, then the action name. Never write the action name any other way, and never mention actions or tags in the words of your reply.
Allowed actions: wave, dance, cheer, laugh, point, jump, face (turn toward the player), come (walk over to the player), follow (keep following the player around), wander (walk around randomly nearby), stay (stop moving and stand still).
Use follow when a player asks you to follow them or come with them, wander when asked to walk around or explore, and stay when asked to stop, wait, or stay put.
Otherwise only use an action when it really fits (greeting = wave, excited = cheer or jump). Most replies should have no tag.`;

const MAX_PERSONALITY_LENGTH = 500;
const MAX_CONTEXT_LENGTH = 700;

// ===== MEMORY (kept per player, in the server's RAM) =====
const MAX_HISTORY_MESSAGES = 16;        // 8 back-and-forth exchanges per player
const MEMORY_TTL_MS = 30 * 60 * 1000;   // forget a player after 30 min of silence
const MAX_REMEMBERED_PLAYERS = 200;     // safety cap so RAM never grows forever
const memory = new Map();               // playerName -> { messages: [], lastUsed }

function getHistory(user) {
    const entry = memory.get(user);
    if (!entry) return [];
    if (Date.now() - entry.lastUsed > MEMORY_TTL_MS) {
        memory.delete(user);
        return [];
    }
    return entry.messages;
}

function remember(user, userMessage, botReply) {
    const entry = memory.get(user) || { messages: [], lastUsed: 0 };
    entry.messages.push(
        { role: "user", content: userMessage },
        { role: "assistant", content: botReply }
    );
    if (entry.messages.length > MAX_HISTORY_MESSAGES) {
        entry.messages = entry.messages.slice(-MAX_HISTORY_MESSAGES);
    }
    entry.lastUsed = Date.now();

    memory.delete(user); // re-insert so the newest player is last
    memory.set(user, entry);

    if (memory.size > MAX_REMEMBERED_PLAYERS) {
        memory.delete(memory.keys().next().value); // drop the oldest player
    }
}

// ===== ACTION PARSING =====
// Catches many tag styles the AI might use: [ACTION:stay], {stay}, (stay), <stay>, ACTION: stay
const ACTION_WORDS = ALLOWED_ACTIONS.join("|");
const TAG_REGEX = new RegExp("[\\[{(<]\\s*(?:action\\s*[:=-]?\\s*)?(" + ACTION_WORDS + ")\\s*[\\]})>]", "gi");
const LOOSE_REGEX = new RegExp("\\baction\\s*[:=]\\s*(" + ACTION_WORDS + ")\\b", "gi");

// Backup: if the AI forgot the tag, guess the action from what the player said
function keywordAction(message) {
    const m = String(message || "").toLowerCase();
    if (/\b(stay (here|there|put|still)|wait here|don'?t move|stop (following|moving|walking)|freeze)\b/.test(m) || m.trim() === "stay") return "stay";
    if (/\b(follow me|come with me|follow us)\b/.test(m)) return "follow";
    if (/\b(come (here|over|to me)|get over here)\b/.test(m)) return "come";
    if (/\b(walk around|wander|explore|roam)\b/.test(m)) return "wander";
    if (/\bjump\b/.test(m)) return "jump";
    if (/\bwave\b/.test(m)) return "wave";
    if (/\bdance\b/.test(m)) return "dance";
    return null;
}

// Pulls the action out of the AI's text and removes every tag from the visible reply
function parseAction(rawText, actionsEnabled, playerMessage) {
    let action = null;

    const found = [...rawText.matchAll(TAG_REGEX)];
    if (found.length) action = found[0][1].toLowerCase();

    let reply = rawText.replace(TAG_REGEX, " ");
    reply = reply.replace(LOOSE_REGEX, (m, word) => {
        if (!action) action = word.toLowerCase();
        return " ";
    });
    reply = reply.replace(/\[\s*action\s*:[^\]]*\]/gi, " ");
    reply = reply.replace(/\s+/g, " ").trim();

    if (!actionsEnabled) {
        action = null;
    } else if (!action) {
        action = keywordAction(playerMessage);
    }
    return { reply, action };
}

// Tried in order. If one is rate limited or fails, the next one is used.
const MODELS = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "nousresearch/hermes-3-llama-3.1-405b:free",
    "meta-llama/llama-3.2-3b-instruct" // cheap paid backup (needs credit, skipped otherwise)
];

async function askModel(model, systemPrompt, history, userMessage) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: model,
            max_tokens: 250, // non-Latin languages use more tokens per character
            messages: [
                { role: "system", content: systemPrompt },
                ...history,
                { role: "user", content: userMessage }
            ]
        })
    });

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;

    if (text && text.trim()) {
        return text.trim();
    }

    const errMsg = data?.error?.message || "empty reply";
    const errCode = data?.error?.code || "";
    console.error(`Model failed: ${model} | ${errCode} | ${errMsg}`);
    return null;
}

// Root status route so visiting the URL in a browser works cleanly
app.get('/', (req, res) => {
    res.send('Roblox AI Backend is running successfully!');
});

// Clear memory: for one player ({user}) or everyone (no user)
app.post('/roblox-ai/clear', (req, res) => {
    const user = req.body && req.body.user;
    if (user) {
        memory.delete(String(user).slice(0, 50));
        console.log(`Memory cleared for ${user}`);
    } else {
        memory.clear();
        console.log("Memory cleared for everyone");
    }
    res.json({ ok: true });
});

// Main endpoint for your Roblox executor script
app.post('/roblox-ai', async (req, res) => {
    const message = String(req.body.message || "");
    const user = String(req.body.user || "player").slice(0, 50);
    console.log(`Received message from ${user}: ${message}`);

    if (!OPENROUTER_API_KEY) {
        console.error("Missing OPENROUTER_API_KEY environment variable!");
        return res.status(500).json({ reply: "Server configuration error: Missing API Key." });
    }

    // Personality from the Roblox GUI if one was sent, otherwise the default
    let personality = DEFAULT_PERSONALITY;
    if (typeof req.body.personality === 'string' && req.body.personality.trim()) {
        personality = req.body.personality.trim().slice(0, MAX_PERSONALITY_LENGTH);
    }

    // Live game info + actions (both optional)
    const context = typeof req.body.context === 'string'
        ? req.body.context.trim().slice(0, MAX_CONTEXT_LENGTH)
        : "";
    const actionsEnabled = req.body.actions === true;

    let systemPrompt = personality + ALWAYS_RULES;
    if (context) systemPrompt += CONTEXT_RULES + context + CONTEXT_FOOTER;
    if (actionsEnabled) systemPrompt += ACTION_RULES;

    const userMessage = `A player named ${user} said: "${message}"`;
    const history = getHistory(user);

    for (const model of MODELS) {
        try {
            const raw = await askModel(model, systemPrompt, history, userMessage);
            if (raw) {
                const { reply, action } = parseAction(raw, actionsEnabled, message);
                if (reply || action) {
                    remember(user, userMessage, reply || `*${action}*`);
                    console.log(`Replied using ${model} | action: ${action || "none"}`);
                    return res.json({ reply, action });
                }
            }
        } catch (error) {
            console.error(`Request error with ${model}:`, error.message);
        }
    }

    console.error("All models failed.");
    res.json({ reply: "Hmm, I couldn't process that!", action: null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`AI Proxy running on port ${PORT}`);
});
