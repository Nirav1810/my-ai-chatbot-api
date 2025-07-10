// my-ai-chatbot-backend/server.js
require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const OpenAI = require('openai'); // We still use the OpenAI SDK, but point it to OpenRouter
const Conversation = require('./models/Conversation');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGO_URI;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; // Renamed variable

// --- Basic Validations ---
if (!OPENROUTER_API_KEY) { // Updated validation check
    console.error("Error: OPENROUTER_API_KEY is not set. Please set it in your .env file or environment variables.");
    process.exit(1);
}
if (!MONGODB_URI) {
    console.error("Error: MONGO_URI is not set. Please set it in your .env file or environment variables.");
    process.exit(1);
}

// Initialize OpenAI client, pointing to OpenRouter's base URL
// OpenRouter's API is designed to be compatible with OpenAI's SDK
const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: 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,
    defaultHeaders: {
        "HTTP-Referer": "https://my-ai-chatbot-app.vercel.app", // <--- UPDATE THIS LINE WITH YOUR ACTUAL VERCEL URL
        "X-Title": "My AI Chatbot App",
    },
});

// Middleware
// CORS configuration: Allow frontend requests from specific origins
// During local development, allow localhost:5173
// After Vercel deployment, add your Vercel URL here.
const allowedOrigins = [
    'http://localhost:5173',
    'https://my-ai-chatbot-app.vercel.app', // For local frontend development
    // IMPORTANT: Add your Vercel frontend URL here after deployment (e.g., 'https://your-frontend-name.vercel.app')
    // Example: 'https://my-ai-chatbot-app.vercel.app'
    // If Vercel generates preview URLs, you might need a regex pattern like:
    // /https:\/\/my-ai-chatbot-app-git-.*-yourusername\.vercel\.app/
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));
app.use(express.json()); // Parse JSON request bodies

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => {
        console.error('MongoDB connection error:', err);
        process.exit(1);
    });

// --- API Routes ---

// Get all conversations (for history sidebar)
app.get('/api/conversations', async (req, res) => {
    try {
        const conversations = await Conversation.find({}, 'title createdAt updatedAt')
                                                .sort({ updatedAt: -1 });
        res.json(conversations);
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get a single conversation by ID
app.get('/api/conversations/:id', async (req, res) => {
    try {
        const conversation = await Conversation.findById(req.params.id);
        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        res.json(conversation);
    } catch (error) {
        console.error('Error fetching conversation:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start a new conversation
app.post('/api/conversations/new', async (req, res) => {
    try {
        const newConversation = new Conversation();
        await newConversation.save();
        res.status(201).json(newConversation);
    } catch (error) {
        console.error('Error creating new conversation:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Send a message and get AI response
app.post('/api/chat', async (req, res) => {
    const { conversationId, message } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        let conversation;
        if (conversationId) {
            conversation = await Conversation.findById(conversationId);
            if (!conversation) {
                console.warn(`Conversation ID ${conversationId} not found. Creating a new one.`);
                conversation = new Conversation(); // Create new if ID not found
            }
        } else {
            conversation = new Conversation(); // Create new if no ID provided
        }

        conversation.messages.push({ sender: 'user', text: message });

        // Prepare messages for OpenRouter (context retention: last 10 messages)
        const contextMessages = conversation.messages.slice(-10).map(msg => ({
            role: msg.sender === 'user' ? 'user' : 'assistant',
            content: msg.text
        }));

        // Add a system message to guide the AI
        const chatMessages = [
            { role: 'system', content: 'You are a helpful and friendly AI assistant. Be concise.' },
            ...contextMessages
        ];

        const chatCompletion = await openai.chat.completions.create({
            model: "openai/gpt-3.5-turbo", // <-- Specify the OpenRouter model.
                                           // You can change this to other models OpenRouter supports,
                                           // e.g., "anthropic/claude-3-haiku", "google/gemini-pro"
                                           // Check https://openrouter.ai/models for available models and their names.
            messages: chatMessages,
        });

        const aiResponseText = chatCompletion.choices[0].message.content;

        conversation.messages.push({ sender: 'ai', text: aiResponseText });
        conversation.updatedAt = Date.now();
        await conversation.save();

        res.json({ aiResponse: aiResponseText, conversationId: conversation._id });

    } catch (error) {
        console.error('Error during chat processing:', error);
        if (error.response) {
            console.error('OpenRouter API error:', error.response.status, error.response.data);
            res.status(error.response.status).json({ error: error.response.data });
        } else {
            res.status(500).json({ error: 'Internal server error occurred.' });
        }
    }
});

// Update conversation title
app.put('/api/conversations/:id/title', async (req, res) => {
    try {
        const { title } = req.body;
        if (!title || typeof title !== 'string') {
            return res.status(400).json({ error: 'Valid title is required.' });
        }
        const conversation = await Conversation.findByIdAndUpdate(
            req.params.id,
            { title: title.trim(), updatedAt: Date.now() },
            { new: true }
        );
        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        res.json(conversation);
    } catch (error) {
        console.error('Error updating conversation title:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Export conversation history
app.get('/api/conversations/:id/export/:format', async (req, res) => {
    try {
        const { id, format } = req.params;
        const conversation = await Conversation.findById(id);
        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        const filename = `chat_${conversation._id.toString().substring(0, 8)}.${format}`;

        if (format === 'json') {
            res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
            res.setHeader('Content-Type', 'application/json');
            return res.json(conversation);
        } else if (format === 'txt') {
            let textContent = `Conversation ID: ${conversation._id}\n`;
            textContent += `Title: ${conversation.title || 'Untitled Chat'}\n`;
            textContent += `Created: ${new Date(conversation.createdAt).toLocaleString()}\n`;
            textContent += `Last Updated: ${new Date(conversation.updatedAt).toLocaleString()}\n\n`;
            textContent += '--- Conversation Log ---\n\n';
            conversation.messages.forEach(msg => {
                textContent += `${msg.sender.toUpperCase()} (${new Date(msg.timestamp).toLocaleTimeString()}): ${msg.text}\n\n`;
            });
            res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
            res.setHeader('Content-Type', 'text/plain');
            return res.send(textContent);
        } else {
            return res.status(400).json({ error: 'Invalid export format. Supported: json, txt.' });
        }
    } catch (error) {
        console.error('Error exporting conversation:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});