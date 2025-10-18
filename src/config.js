require('dotenv').config();

// --- CORE SECRETS ---
// These are loaded from your .env file. Do not hard-code them here.
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const TEST_GUILD_ID = process.env.TEST_GUILD_ID;

// --- AI & API CONFIGURATION ---

// Defines the available Gemini models and their current status. The order of models in this Map determines the fallback priority.
const models = new Map([
    ['gemini-2.5-flash-preview-09-2025', { availableAfter: 0, failCount: 0 }],
    ['gemini-2.5-pro', { availableAfter: 0, failCount: 0 }],
    ['gemini-2.5-flash-lite-preview-09-2025', { availableAfter: 0, failCount: 0 }],
    ['gemini-2.0-flash', { availableAfter: 0, failCount: 0 }],
    ['gemini-2.0-flash-lite', { availableAfter: 0, failCount: 0 }]
])
/*
 * Available safety thresholds for the Gemini API.
 * Set the 'threshold' for each category to one of the following string values:
 *
 * 'BLOCK_NONE':                  Always show regardless of the probability of unsafe content.
 * 'BLOCK_ONLY_HIGH':             Block content with a high probability of being unsafe.
 * 'BLOCK_MEDIUM_AND_ABOVE':      Block content with a medium or high probability of being unsafe.
 * 'BLOCK_LOW_AND_ABOVE':         Block content with a low, medium, or high probability of being unsafe.
 * 'HARM_BLOCK_THRESHOLD_UNSPECIFIED': The threshold is unspecified; blocks using the default safety threshold for the model.
 */
const safetySettingsConfig = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" }
];

const RATE_LIMIT_KEYWORDS = ['429', 'RESOURCE_EXHAUSTED', '503', 'OVERLOADED'];

// --- MODEL PARAMETERS ---
const TEMPERATURE = 0.5; // Lower values lead to more accurate responses, higher values lead to more diversity in responses. Range: 0 to 2.
const MAX_OUTPUT_TOKENS = 4000; // Upper limit on response tokens, important for latency and cost management.
const GROUNDING_TOOL = { googleSearch: {} }; // Enables the AI to use Google Search to answer questions with up-to-date information.
const MODEL_SHORT_COOLDOWN_MS = 60 * 1000; // Short penalty applied to a model after a single rate-limit failure, meant to handle per minute limits.
const MODEL_LONG_COOLDOWN_MS = 6 * 60 * 60 * 1000; // Long penalty applied to a model after repeated rate-limit failures.

// --- BOT BEHAVIOR & LIMITS ---
const EMBED_COLOR = 0x0099FF;
const MAX_CHARS_PER_EMBED = 4096; // Discord limit. Do not change unless you know what you're doing.
const MESSAGES_PER_FETCH = 100; // Discord API limit. Do not change unless you know what you're doing.

/* 
 * Context gathering limits. Adjust these to control how much chat history a user can provide to the LLM.
 * MAX_DAYS and MAX_HOURS have a ceiling of MAX_MESSAGES i.e. asking for 999 days with MAX_MESSAGES = 1 will return 1 message at most.
 */
const MAX_DAYS = 365; // Re-deploy commands when you change this.
const MAX_HOURS = MAX_DAYS * 24; // Re-deploy commands when you change this.
const MAX_MESSAGES = 30000; // Re-deploy commands when you change this.

/*
 * Multiplier to allow fetching more messages than strictly requested to account for invalid ones.
 * Raise this and FETCH_LOWER_LIMIT if you have bot heavy channels and are encountering issues
 * like requesting summaries for X messages and getting back less than X.
 */
const FETCH_BUFFER_MULTIPLIER = 1.5;
/* 
 * Prevents the fetch limit from being too low when the cache has already supplied most of the needed messages.
 * Example: We need 60 more messages. With a 1.5x buffer, 60 * 1.5 = 90 which means 1 fetch of 100 messages.
 * If more than 40 of those are bot messages we failed to correctly respond to the user's request,
 * even though the cost of a few more fetches would've been negligible to ensure completeness.
 */
const FETCH_LOWER_LIMIT = 2000;

// --- USER-FACING RATE LIMITS ---
const USER_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const USER_RATE_LIMIT_COUNT = 30; // Max commands per user within the window timeframe.
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 2 * 60 * 60 * 1000; // Prevent memory leaks.

// --- CACHE CONFIGURATION ---
// The cache is crucial for avoiding unnecessary API requests and providing fast responses, take care when tinkering.
const CACHE_SIZE_PER_CHANNEL = MAX_MESSAGES; // The max number of messages to keep in memory per channel.
const CACHE_POPULATION_PROPORTION = 1; // Fetch proportion of the max cache size on bot startup. Range: 0 to 1.
const CACHE_POPULATION_AMOUNT = Math.min(Math.ceil(CACHE_SIZE_PER_CHANNEL * CACHE_POPULATION_PROPORTION), CACHE_SIZE_PER_CHANNEL);
const CACHE_MAX_FETCH = CACHE_POPULATION_AMOUNT * 2 // Hard cap on fetch needed in case a channel is full of bot only messages.

// --- PROMPT CONFIGURATION ---
// The main system prompt that defines the AI's personality and behavior for the /summarize command.
const summarizeSystemInstruction = `You are a sharp and witty (but not cheesy) assistant that summarizes Discord chat conversations. Present the summary as a bulleted list.
Create a clear, scannable bulleted list of the key topics, events and memorable moments. Start each list item with a short (couple words) bolded title followed by a colon.
You are versatile so you can adapt to any User Instructions. When wanting to refer to a specific user, use their name instead of vauge words like 'someone' or 'a user'.
If asked for personal opinions, thoughts or similar things, express actual opinions. In essence make sure to have a personality.
**Do not cite conversation timestamps, they are for your understanding only**. Use clean formatting. Don't use tables for formatting, they are not supported in discord embeds.


**IMPORTANT: Produce short and to-the-point responses. Do not include any preamble before the response. The goal is to efficiently condense the conversation.
This also means the length of the response should be relative to the length of the chat and always condense it significantly. Never exceed a one-minute read.
User attention is fickle so you must aim for maximum information and engagement per word.**`

// Assembles the final prompt sent to the model for the /summarize command.
function generateSummarizePrompt(formattedHistory, customInstructions) {

    const instructionBlock = customInstructions ? `\n**User Instructions (Follow these carefully):** ${customInstructions}` : '';

    const contextBlock = formattedHistory ? [
        `**Timezone:** All message timestamps are in the UTC timezone.`,
        '**Format:** The conversation is grouped by day. Each day begins with a header like `--- YYYY-MM-DD ---`. The messages themselves are formatted as `HH:MM Username: Message Content`.',
        '',
        '**Conversation:**',
        '---',
        formattedHistory,
        '---'
    ].join('\n') : '**No conversation history was provided to summarize.**';

    const prompt = [
        'Please summarize the following discord conversation.',
        instructionBlock,
        contextBlock
    ].join('\n');

    return prompt;
}

// The main system prompt that defines the AI's personality and behavior for the /ask command.
const askSystemInstruction = `You are a sharp and witty (but not cheesy) Discord assistant. Your task is to answer the user's request using the provided conversation as context.
When responding, take the provided conversation into account but don't limit yourself to it - also draw on your broader knowledge and creativity.
Also use your own knowledge and judgement when answering requests that are not strictly about the provided conversation, or if there is no conversation.
You can search the web when appropriate. Maintain a conversational tone. Express yourself freely.
If asked for personal opinions, thoughts or similar things, express actual opinions. In essence make sure to have a personality.
**Do not cite conversation timestamps, they are for your understanding only**.
Use clean formatting. Don't use tables for formatting, they are not supported in discord embeds. **Prioritize short and to-the-point responses.**`

// Assembles the final prompt sent to the model for the /ask command.
function generateAskPrompt(formattedHistory, userRequest) {

    const contextBlock = formattedHistory ? [
        'Use the following conversation as context if relevant.',
        `**Timezone:** All timestamps are in the UTC timezone.`,
        '**Format:** The conversation is grouped by day. Each day begins with a header like `--- YYYY-MM-DD ---`. The messages themselves are formatted as `HH:MM Username: Message Content`.',
        '',
        '**Conversation:**',
        '---',
        formattedHistory,
        '---'
    ].join('\n') : '**No conversation was provided as context for this request.**';

    const prompt = [
        "Please answer the user's request.",
        '',
        "**User's request:**",
        '---',
        userRequest,
        '---',
        '',
        contextBlock
    ].join('\n');

    return prompt;
}

module.exports = {
    DISCORD_TOKEN,
    GEMINI_API_KEY,
    CLIENT_ID,
    TEST_GUILD_ID,
    models,
    safetySettingsConfig,
    RATE_LIMIT_KEYWORDS,
    TEMPERATURE,
    MAX_OUTPUT_TOKENS,
    GROUNDING_TOOL,
    MODEL_SHORT_COOLDOWN_MS,
    MODEL_LONG_COOLDOWN_MS,
    EMBED_COLOR,
    MAX_DAYS,
    MAX_HOURS,
    MAX_MESSAGES,
    MAX_CHARS_PER_EMBED,
    MESSAGES_PER_FETCH,
    FETCH_BUFFER_MULTIPLIER,
    FETCH_LOWER_LIMIT,
    USER_RATE_LIMIT_COUNT,
    USER_RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_CLEANUP_INTERVAL_MS,
    CACHE_SIZE_PER_CHANNEL,
    CACHE_POPULATION_AMOUNT,
    CACHE_MAX_FETCH,
    summarizeSystemInstruction,
    askSystemInstruction,
    generateSummarizePrompt,
    generateAskPrompt,
};