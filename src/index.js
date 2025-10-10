const { performance } = require('perf_hooks');
const { Client, GatewayIntentBits, Partials, Options, Collection, EmbedBuilder, LimitedCollection, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { GoogleGenAI } = require("@google/genai");
const { isValidMessage, createMinimalMessage, formatChatHistoryByDay } = require('./utils.js');
const {
    DISCORD_TOKEN,
    GEMINI_API_KEY,
    models,
    safetySettingsConfig,
    RATE_LIMIT_KEYWORDS,
    TEMPERATURE,
    GROUNDING_TOOL,
    MODEL_SHORT_COOLDOWN_MS,
    MODEL_LONG_COOLDOWN_MS,
    EMBED_COLOR,
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
} = require('./config.js');

if (!DISCORD_TOKEN || !GEMINI_API_KEY) {
    console.error("Missing DISCORD_TOKEN or GEMINI_API_KEY in .env file.");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
    makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings, // Start with default settings for all managers
        MessageManager: { // Override settings for MessageManager
            maxSize: 0, // Cache up to this many messages per channel (we are not using the message cache)
        },
        ReactionManager: 0, // You can just pass maxSize directly as well (not using reactions either)
        ReactionUserManager: 0,
        PresenceManager: 0,
        VoiceStateManager: 0,
        GuildEmojiManager: 0,
        GuildStickerManager: 0,
    }),
});

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

/**
 * Caches recent messages for each channel to avoid API calls.
 * The key is the channel ID, and the value is a LimitedCollection of messages.
 * @type {Map<string, LimitedCollection>}
 */
const messageCache = new Map();

/**
 * Tracks command timestamps for each user to enforce rate limits.
 * The key is the user ID, and the value is an array of timestamps.
 * @type {Map<string, number[]>}
 */
const userRateLimits = new Map();

let isCacheReady = false; // Events and interactions depending on the cache are deferred until this is true.
let pendingEvents = []; // This queue holds events that arrive during startup.

// All other model response finish reasons are treated as 'soft failures, aka we try the next available model.
const SUCCESS_FINISH_REASONS = new Set(['STOP', 'MAX_TOKENS']);
const HARD_STOP_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

function handleMessageCreate(message) {
    if (!isValidMessage(message)) return;
    const channelCache = messageCache.get(message.channelId) || messageCache.set(message.channelId, new LimitedCollection({ maxSize: CACHE_SIZE_PER_CHANNEL })).get(message.channelId);
    if (!channelCache.has(message.id)) {
        channelCache.set(message.id, createMinimalMessage(message));
    }
}

function handleMessageUpdate(newMessage) {
    const channelCache = messageCache.get(newMessage.channelId);
    // Only act if we are tracking this channel and have the message cached.
    if (!channelCache?.has(newMessage.id)) return;

    if (isValidMessage(newMessage)) {
        channelCache.set(newMessage.id, createMinimalMessage(newMessage));
    } else {
        channelCache.delete(newMessage.id);
    }
}

function handleMessageDelete(message) {
    messageCache.get(message.channelId)?.delete(message.id)
}

function handleMessageDeleteBulk(messages, channel) {
    const channelCache = messageCache.get(channel.id);
    if (channelCache) {
        for (const messageId of messages.keys()) {
            channelCache.delete(messageId);
        }
    }
}

function handleChannelDelete(channel) {
    messageCache.delete(channel.id) && console.log(`[CACHE SWEEP] Removed cache for channel #${channel.name} (${channel.id}) as it was deleted.`);
}

async function populateChannel(channel, guild) {
    try {
        console.log(`[CACHE_TEST] Starting fetch for channel #${channel.name} in guild "${guild.name}".`);
        const minimalMessages = [];
        let lastId;
        const loops = Math.ceil(CACHE_MAX_FETCH / MESSAGES_PER_FETCH);

        outerLoop: for (let i = 0; i < loops; i++) {
            const batch = await channel.messages.fetch({ limit: MESSAGES_PER_FETCH, before: lastId });
            if (batch.size === 0) break;

            for (const message of batch.values()) {
                if (isValidMessage(message)) {
                    minimalMessages.push(createMinimalMessage(message));
                    if (minimalMessages.length >= CACHE_POPULATION_AMOUNT) break outerLoop;
                }
            }
            lastId = batch.last().id;

            if (batch.size < MESSAGES_PER_FETCH) break;
        }

        if (minimalMessages.length === 0) {
            console.log(`[CACHE_TEST] No valid messages found to cache for #${channel.name}.`);
            return;
        }

        const channelCache = messageCache.set(channel.id, new LimitedCollection({ maxSize: CACHE_SIZE_PER_CHANNEL })).get(channel.id);

        // Reverse the array to get chronological order (oldest to newest) for correct cache eviction.
        minimalMessages.reverse();

        for (const minimalMessage of minimalMessages) {
            channelCache.set(minimalMessage.id, minimalMessage);
        }
        console.log(`[CACHE_TEST] Successfully cached ${channelCache.size} messages for channel #${channel.name} in guild "${guild.name}".`);

    } catch (error) {
        if (error.code === 50001 || error.code === 50013) {
            console.warn(`[CACHE_TEST] Skipped channel #${channel.name} in guild "${guild.name}" due to missing permissions.`);
        } else {
            console.error(`[CACHE_TEST] Failed to populate cache for channel #${channel.name}:`, error);
        }
    }
}

client.once('clientReady', async () => {
    const startTime = performance.now();
    console.log(`[CACHE_TEST] *** STARTING CACHE POPULATION PROCESS ***`);
    console.log(`[CACHE_TEST] Configuration: CACHE_SIZE_PER_CHANNEL=${CACHE_SIZE_PER_CHANNEL}, CACHE_POPULATION_AMOUNT=${CACHE_POPULATION_AMOUNT}`);
    console.log(`Logged in as ${client.user.tag}! Bot is in ${client.guilds.cache.size} servers.`);

    const populationPromises = [];

    for (const guild of client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
            if (channel.isTextBased() && channel.viewable) {
                populationPromises.push(populateChannel(channel, guild));
            }
        }
    }

    await Promise.all(populationPromises);
    const historicalFetchTime = performance.now();
    console.log(`[CACHE_TEST] *** HISTORICAL FETCH COMPLETE ***`);
    console.log(`[CACHE_TEST] ⏳ Time taken for historical fetch: ${(historicalFetchTime - startTime).toFixed(2)} ms`);
    console.log(`[CACHE_TEST] ----------------------------------------------------`);

    console.log(`[CACHE_TEST] *** STARTING PENDING QUEUE PROCESSING ***`);
    console.log(`[CACHE_TEST] Processing ${pendingEvents.length} events that arrived during startup...`);

    for (const eventFunction of pendingEvents) {
        eventFunction();
    }

    pendingEvents = [];
    isCacheReady = true;
    const endTime = performance.now();
    console.log(`[CACHE_TEST] *** CACHE IS FULLY SYNCHRONIZED ***`);
    console.log(`[CACHE_TEST] ⏳ Total startup time: ${(endTime - startTime).toFixed(2)} ms.`);
});

client.on('messageCreate', message => {
    if (isCacheReady) {
        handleMessageCreate(message);
    } else {
        pendingEvents.push(() => handleMessageCreate(message));
    }
});

client.on('messageUpdate', (oldMessage, newMessage) => {
    if (isCacheReady) {
        handleMessageUpdate(newMessage);
    } else {
        pendingEvents.push(() => handleMessageUpdate(newMessage));
    }
});

client.on('messageDelete', message => {
    if (isCacheReady) {
        handleMessageDelete(message);
    } else {
        pendingEvents.push(() => handleMessageDelete(message));
    }
});

client.on('messageDeleteBulk', (messages, channel) => {
    if (isCacheReady) {
        handleMessageDeleteBulk(messages, channel);
    } else {
        pendingEvents.push(() => handleMessageDeleteBulk(messages, channel));
    }
});

client.on('channelDelete', channel => {
    if (isCacheReady) {
        handleChannelDelete(channel);
    } else {
        pendingEvents.push(() => handleChannelDelete(channel));
    }
});

client.on('interactionCreate', async interaction => {
    // Handles the 'make public' button on ephemeral responses
    if (interaction.isButton()) {
        try {
            await interaction.deferUpdate();

            const [action, originalAuthorId] = interaction.customId.split(':');

            if (action === 'make_public') {
                if (interaction.user.id !== originalAuthorId) {
                    await interaction.followUp({ content: "You are not the original author of this request and cannot make it public.", flags: MessageFlags.Ephemeral });
                    return;
                }

                const originalEmbed = interaction.message.embeds[0];
                if (!originalEmbed) {
                    await interaction.followUp({ content: "An error occurred: The original message content could not be found.", flags: MessageFlags.Ephemeral });
                    return;
                }

                await interaction.channel.send({ embeds: [originalEmbed] });

                await interaction.deleteReply();
            }
        } catch (error) {
            console.error("Error processing 'make_public' button interaction:", error);
            try {
                if (error.code === 50001 || error.code === 50013) {
                    await interaction.followUp({ content: "Couldn't make this message public, likely due to missing permissions.", flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.followUp({ content: 'Something went wrong while trying to make this message public.', flags: MessageFlags.Ephemeral });
                }
            } catch (followUpError) {
                console.error("Failed to send error follow-up message:", followUpError);
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
        const { commandName, options, channel, user } = interaction;

        if (commandName === 'summarize' || commandName === 'ask') {
            const isPublic = options.getBoolean('public') ?? false;
            await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });

            const subcommand = options.getSubcommand();
            const needsCache = !(commandName === 'ask' && subcommand === 'now');

            if (needsCache && !isCacheReady) {
                await interaction.editReply({
                    content: "I'm still starting up. Please try again in a moment! You can use commands that don't require context in the meantime.",
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            // --- START RATE LIMIT LOGIC ---
            const now = Date.now();
            const userTimestamps = userRateLimits.get(user.id) || [];

            // Filter out any timestamps that are outside our sliding window.
            const recentTimestamps = userTimestamps.filter(ts => now - ts < USER_RATE_LIMIT_WINDOW_MS);

            if (recentTimestamps.length >= USER_RATE_LIMIT_COUNT) {
                const oldestRecentTimestamp = recentTimestamps[0];
                const cooldownEnds = oldestRecentTimestamp + USER_RATE_LIMIT_WINDOW_MS;
                const timeLeftSeconds = Math.ceil((cooldownEnds - now) / 1000);

                console.log(`[RATE LIMIT] User ${user.id} was rate-limited. Try again in ${timeLeftSeconds}s.`);

                await interaction.editReply({
                    content: `You are making requests too quickly. Please try again in **${timeLeftSeconds}** second(s).`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            // The user is clear. Add the current timestamp to their history for future checks.
            recentTimestamps.push(now);
            userRateLimits.set(user.id, recentTimestamps);
            // ---  END RATE LIMIT LOGIC  ---

            const isAnyModelAvailable = [...models.values()].some(status => Date.now() > status.availableAfter);
            if (!isAnyModelAvailable) {
                console.log("[Pre-flight Check] Failed: All models are on cooldown.");
                await interaction.editReply('All AI models are currently on cooldown. Please try again later.');
                return;
            }
            // Initialize a Collection to store message history.
            // Note: Messages are added from newest to oldest, then reversed when formatting the history for chronological processing.
            let chatHistory = new Collection();
            let fetchDetails = '';
            const channelCache = messageCache.get(channel.id) || messageCache.set(channel.id, new LimitedCollection({ maxSize: CACHE_SIZE_PER_CHANNEL })).get(channel.id);

            if (subcommand === 'now') {
                fetchDetails = 'Without message context';
            } else if (subcommand === 'amount') {
                const count = options.getInteger('count');
                fetchDetails = `The last ${count} messages`;
                let lastId;

                // Fetch from the cache first.
                const reversedCache = [...channelCache.values()].reverse();  // reverse to get the newest N messages AND line up with the fetch (newest -> oldest)
                for (const message of reversedCache) {
                    if (chatHistory.size >= count) break;
                    chatHistory.set(message.id, message); // We already check for validity and minimize the message when adding it to cache
                }
                if (chatHistory.size > 0) lastId = chatHistory.last().id; // lastId being undefined means fetch the newest messages
                console.log(`[CACHE HIT - amount] Collected ${chatHistory.size} messages from cache.`);
                // Fetch the rest from the API
                if (chatHistory.size < count) { // count should always be at most MAX_MESSAGES via deploy-commands.js
                    // Reasonable upper fetch limit to account for channels with mostly bot messages
                    const fetchLoops = Math.ceil(Math.max((MAX_MESSAGES - chatHistory.size) * FETCH_BUFFER_MULTIPLIER, FETCH_LOWER_LIMIT) / MESSAGES_PER_FETCH)
                    outer: for (let i = 0; i < fetchLoops; i++) {
                        const batch = await channel.messages.fetch({ limit: MESSAGES_PER_FETCH, before: lastId });
                        if (batch.size === 0) break;

                        for (const message of batch.values()) {
                            if (chatHistory.size >= count) break outer;
                            if (isValidMessage(message)) chatHistory.set(message.id, createMinimalMessage(message)); // fetch is newest -> oldest, can just set
                        }
                        lastId = batch.last().id;

                        if (batch.size < MESSAGES_PER_FETCH) break;
                    }
                }
            } else if (subcommand === 'days' || subcommand === 'hours') {
                const duration = options.getNumber('duration');
                let timeUnitMultiplier;
                let targetTimestamp;
                let lastId;

                if (subcommand === 'days') {
                    fetchDetails = `Messages from the last ${duration} day(s)`;
                    timeUnitMultiplier = 24 * 60 * 60 * 1000;
                } else {
                    fetchDetails = `Messages from the last ${duration} hour(s)`;
                    timeUnitMultiplier = 60 * 60 * 1000;
                }
                targetTimestamp = Date.now() - (duration * timeUnitMultiplier);

                const reversedCache = [...channelCache.values()].reverse();
                for (const message of reversedCache) {
                    if (message.createdTimestamp < targetTimestamp) break;
                    chatHistory.set(message.id, message);
                }
                if (chatHistory.size > 0) lastId = chatHistory.last().id;
                console.log(`[CACHE HIT - days/hours] Collected ${chatHistory.size} messages from cache.`);
                if ((!lastId || chatHistory.last().createdTimestamp > targetTimestamp) && chatHistory.size < MAX_MESSAGES) {
                    const fetchLoops = Math.ceil(Math.max((MAX_MESSAGES - chatHistory.size) * FETCH_BUFFER_MULTIPLIER, FETCH_LOWER_LIMIT) / MESSAGES_PER_FETCH)
                    outer: for (let i = 0; i < fetchLoops; i++) {
                        const batch = await channel.messages.fetch({ limit: MESSAGES_PER_FETCH, before: lastId });
                        if (batch.size === 0) break;

                        for (const message of batch.values()) {
                            if (message.createdTimestamp < targetTimestamp) break outer;
                            if (chatHistory.size >= MAX_MESSAGES) break outer;
                            if (isValidMessage(message)) chatHistory.set(message.id, createMinimalMessage(message));
                        }
                        lastId = batch.last().id;

                        if (batch.size < MESSAGES_PER_FETCH) break;
                    }
                }
            } else if (subcommand === 'since_last') {
                fetchDetails = "Messages since your last message";
                let userLastMessageId = null;
                let lastId;

                const reversedCache = [...channelCache.values()].reverse();
                for (const message of reversedCache) {
                    if (message.author.id === user.id) {
                        userLastMessageId = message.id;
                        break;
                    }
                    chatHistory.set(message.id, message);
                }
                if (chatHistory.size > 0) lastId = chatHistory.last().id;
                console.log(`[CACHE HIT - since_last] Collected ${chatHistory.size} messages from cache.`);
                if (userLastMessageId === null && chatHistory.size < MAX_MESSAGES) {
                    const fetchLoops = Math.ceil(Math.max((MAX_MESSAGES - chatHistory.size) * FETCH_BUFFER_MULTIPLIER, FETCH_LOWER_LIMIT) / MESSAGES_PER_FETCH)
                    outer: for (let i = 0; i < fetchLoops; i++) {
                        const batch = await channel.messages.fetch({ limit: MESSAGES_PER_FETCH, before: lastId });
                        if (batch.size === 0) break;

                        for (const message of batch.values()) {
                            if (message.author?.id === user.id) {
                                userLastMessageId = message.id;
                                break outer;
                            }
                            if (chatHistory.size >= MAX_MESSAGES) break outer;
                            if (isValidMessage(message)) chatHistory.set(message.id, createMinimalMessage(message));
                        }
                        lastId = batch.last().id;

                        if (batch.size < MESSAGES_PER_FETCH) break;
                    }
                }
                if (!userLastMessageId) {
                    await interaction.editReply(`Couldn't find one of your messages in the last ~${MAX_MESSAGES} messages. Please send a message first or use a different summarize option.`);
                    return;
                }
            }
            if (subcommand !== 'now' && chatHistory.size < 1) {
                await interaction.editReply(`Not enough messages found in ${fetchDetails} to provide context (found ${chatHistory.size}). Need at least 1 non-bot message with content.`);
                return;
            }

            formattedHistory = formatChatHistoryByDay(chatHistory, client);

            let prompt;
            let systemInstructionToUse;
            let request = null;
            let customInstructions = null;

            if (commandName === 'summarize') {
                customInstructions = options.getString('instructions') || null;
                prompt = generateSummarizePrompt(formattedHistory, customInstructions);
                systemInstructionToUse = summarizeSystemInstruction;
            } else if (commandName === 'ask') {
                request = options.getString('request');
                prompt = generateAskPrompt(formattedHistory, request);
                systemInstructionToUse = askSystemInstruction;
            }

            let responseText = '';
            let promptTooLarge = false;
            let successfulModelName = '';
            // This loop will try each model until one succeeds.
            for (const [modelName, status] of models.entries()) {
                if (status.availableAfter > Date.now()) {
                    console.log(`[Model Switcher] Skipping ${modelName}, it's on cooldown.`);
                    continue; // Go to the next model in the map.
                }
                /* 
                Flags to prevent doubly penalizing a model due to concurrency.
                I believe only one of them is necessary given the nature of the js event loop (aka the catch block will execute atomically).
                I'm using both to show that these point to a single consistent state.
                */
                const availableWhenStarted = status.availableAfter;
                const failCountWhenStarted = status.failCount;

                try {
                    console.log(`[Model Switcher] Attempting to use model: ${modelName}`);
                    // Make the API call with the current model.
                    const generationResponse = await genAI.models.generateContent({
                        model: modelName,
                        contents: prompt,
                        config: {
                            systemInstruction: systemInstructionToUse,
                            // maxOutputTokens: 4000,
                            temperature: TEMPERATURE,
                            safetySettings: safetySettingsConfig,
                            tools: [GROUNDING_TOOL],
                        },
                    });

                    // Check if the prompt itself was blocked.
                    const promptBlockReason = generationResponse.promptFeedback?.blockReason;
                    if (promptBlockReason) {
                        console.warn(`[SAFETY BLOCK] Prompt was blocked. Details:`, generationResponse.promptFeedback);
                        await interaction.editReply(`The request could not be completed because the input conversation or your instructions were flagged for **${promptBlockReason}**.`);
                        return; // Stop processing this interaction entirely.
                    }

                    // Check if response finished for unsafe reason.
                    const candidate = generationResponse.candidates?.[0];
                    if (HARD_STOP_FINISH_REASONS.has(candidate?.finishReason)) {
                        console.warn(`[SAFETY BLOCK] ${modelName} response was blocked. Details:`, {
                            finishReason: candidate?.finishReason,
                            safetyRatings: candidate?.safetyRatings,
                        });
                        await interaction.editReply(`The request could not be completed because the generated response was flagged for **${candidate?.finishReason}**.`);
                        return;
                    }

                    // Check if response finished successfully.
                    if (!SUCCESS_FINISH_REASONS.has(candidate?.finishReason)) {
                        console.warn(`[Model Switcher] ${modelName} response finished unexpectedly. Details:`, {
                            finishReason: candidate?.finishReason,
                            safetyRatings: candidate?.safetyRatings,
                        });
                        continue; // Failover if it wasn't.
                    }

                    // Handle a successful response.
                    console.log(`[Model Switcher] Success with ${modelName}!`);
                    responseText = generationResponse.text;
                    successfulModelName = modelName;
                    status.availableAfter = 0;
                    status.failCount = 0;
                    break; // Exit the loop since we have a successful summary.

                } catch (error) {
                    // Handle an error for THIS specific model.
                    const errorMessage = (error.message || '').toUpperCase();
                    if (errorMessage.includes('INPUT_TOKEN_COUNT') || errorMessage.includes('INPUT TOKEN COUNT')) {
                        console.warn(`[Model Switcher] ${modelName} context window is too small for this request (input token limit). Trying next model.`);
                        // No penalty. Just move on to the next model.
                        promptTooLarge = true;
                        continue;
                    }
                    promptTooLarge = false;

                    if (RATE_LIMIT_KEYWORDS.some(keyword => errorMessage.includes(keyword))) { // Too many requests
                        if (status.availableAfter > availableWhenStarted || status.failCount > failCountWhenStarted) {
                            console.warn(`[Model Switcher] ${modelName} was already penalized by another concurrent request. Skipping penalty and retrying next model.`);
                            continue;
                        }
                        status.failCount++;
                        const cooldownDuration = (status.failCount > 1) ? MODEL_LONG_COOLDOWN_MS : MODEL_SHORT_COOLDOWN_MS;
                        status.availableAfter = Date.now() + cooldownDuration;
                        console.warn(`[Model Switcher] ${modelName} is rate-limited. Applying penalty.`);
                        continue;
                    } else {
                        console.error('An unrecoverable error occurred:', error);
                        await interaction.editReply('An error occurred with the AI model. Could not generate a summary.');
                        return;
                    }
                }
            }

            // --- FINAL REPLY LOGIC ---

            if (!successfulModelName) {
                if (promptTooLarge) {
                    await interaction.editReply("The conversation you requested is too long. Please try summarizing a smaller amount or shorter time frame.");
                } else {
                    await interaction.editReply('All AI models are currently busy or rate-limited. Please try again later.');
                }
                return;
            }

            const baseTitle = commandName === 'summarize' ? 'Chat Summary' : `${interaction.guild?.members.me?.displayName || 'Summaru'} says`;
            let contextDetails = (chatHistory.size > 0) ? ` - ${fetchDetails} (${chatHistory.size} messages processed)` : '';
            const title = baseTitle + contextDetails;

            let descriptionContent;

            // Use Markdown to format the user's input at the top of the description.
            if (commandName === 'summarize' && customInstructions) {
                descriptionContent = `**Instructions:** ${customInstructions}\n\n**Summary:**\n ${responseText}`;
            } else if (commandName === 'ask') {
                descriptionContent = `**Request:** ${request}\n\n**Response:** ${responseText}`;
            } else {
                // For a summary with no custom instructions.
                descriptionContent = responseText;
            }

            // The combined description is subject to the character limit.
            if (descriptionContent.length > MAX_CHARS_PER_EMBED) {
                descriptionContent = descriptionContent.substring(0, MAX_CHARS_PER_EMBED - 3) + '...';
            }

            const summaryEmbed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(title)
                .setDescription(descriptionContent)
                .setTimestamp()
                .setFooter({ text: `Requested by ${user.displayName} • Made with ${successfulModelName}`, iconURL: user.displayAvatarURL() });

            const replyOptions = { embeds: [summaryEmbed] };

            if (!isPublic) {
                const makePublicButton = new ButtonBuilder()
                    .setCustomId(`make_public:${user.id}`) // Embed the user's ID for verification
                    .setLabel('Make Public')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('📢');

                const row = new ActionRowBuilder().addComponents(makePublicButton);
                replyOptions.components = [row];
            }
            await interaction.editReply(replyOptions);
        }
    } catch (error) {
        console.error('Error processing chat command:', error);
        try {
            if (error.code === 50001 || error.code === 50013) {
                await interaction.editReply("Couldn't process command, likely due to missing permissions.");
            } else {
                await interaction.editReply('An unexpected error occurred while processing the command. If this keeps happening, please contact the bot owner.');
            }
        } catch (e) {
            console.error("Failed to send error reply:", e);
        }
    }
});

// Periodically clean up the userRateLimits map to prevent a memory leak.
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [userId, timestamps] of userRateLimits.entries()) {
        // If the most recent timestamp for a user is older than our rate limit window it's safe to remove them completely.
        if (now - timestamps[timestamps.length - 1] > USER_RATE_LIMIT_WINDOW_MS) {
            userRateLimits.delete(userId);
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) {
        console.log(`[MAINTENANCE] Cleaned up ${cleanedCount} old entries from the user rate limit cache.`);
    }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

client.login(DISCORD_TOKEN);