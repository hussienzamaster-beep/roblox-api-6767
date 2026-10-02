const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

app.post('/roblox-ai', async (req, res) => {
    const { user, message } = req.body;
    console.log(`Received message from ${user}: ${message}`);

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "model": "meta-llama/llama-3.2-3b-instruct:free",
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a short, casual, and friendly NPC chatbot inside a Roblox game."
                    },
                    {
                        "role": "user",
                        "content": `A player named ${user} said: "${message}"`
                    }
                ]
            })
        });

        const data = await response.json();
        
        if (data.choices && data.choices[0]) {
            const replyText = data.choices[0].message.content;
            res.json({ reply: replyText });
        } else {
            console.error("OpenRouter Error Data:", data);
            res.json({ reply: "Hmm, I couldn't process that!" });
        }
    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ reply: "Error connecting to AI backend." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`AI Proxy running on port ${PORT}`);
});
