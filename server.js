const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Tried in order. If one is rate limited or fails, the next one is used.
const MODELS = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "nousresearch/hermes-3-llama-3.1-405b:free",
    "meta-llama/llama-3.2-3b-instruct" // cheap paid backup (needs credit, skipped otherwise)
];

async function askModel(model, user, message) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: model,
            max_tokens: 150,
            messages: [
                {
                    role: "system",
                    content: "You are a short, casual, and friendly NPC chatbot inside a Roblox game. Keep replies under 150 characters."
                },
                {
                    role: "user",
                    content: `A player named ${user} said: "${message}"`
                }
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

// Main endpoint for your Roblox executor script
app.post('/roblox-ai', async (req, res) => {
    const { user, message } = req.body;
    console.log(`Received message from ${user}: ${message}`);

    if (!OPENROUTER_API_KEY) {
        console.error("Missing OPENROUTER_API_KEY environment variable!");
        return res.status(500).json({ reply: "Server configuration error: Missing API Key." });
    }

    for (const model of MODELS) {
        try {
            const reply = await askModel(model, user, message);
            if (reply) {
                console.log(`Replied using ${model}`);
                return res.json({ reply });
            }
        } catch (error) {
            console.error(`Request error with ${model}:`, error.message);
        }
    }

    console.error("All models failed.");
    res.json({ reply: "Hmm, I couldn't process that!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`AI Proxy running on port ${PORT}`);
});
