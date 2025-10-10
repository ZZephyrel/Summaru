function isValidMessage(message) {
    // 1. Ensure the message object and its author exist.
    if (!message || !message.author) {
        return false;
    }

    // 2. Filter out bots.
    if (message.author.bot) {
        return false;
    }

    // 3. Ensure the message has text content.
    if (!message.content || message.content.trim() === '') {
        return false;
    }

    // 4. Ensure the message is in a valid channel.
    if (!message.channelId) {
        return false;
    }

    // If all checks pass, the message is valid.
    return true;
}

function createMinimalMessage(message) {
    return {
        id: message.id,
        channelId: message.channelId,
        createdTimestamp: message.createdTimestamp,
        content: message.content,
        author: {
            id: message.author.id,
            displayName: message.author.displayName,
        }
    };
}

function resolveDisplayNameForMessage(message, client) {
    const currentUser = client.users.cache.get(message.author.id); // Cached name guarantees freshness.

    if (currentUser) return currentUser.displayName;

    return message.author.displayName;
}

// This function is a hot path, it needs to be performant
function formatChatHistoryByDay(chatHistory, client) {
    if (chatHistory.size === 0) return null;

    const sortedHistory = Array.from(chatHistory.values()).reverse();

    const formattedLines = [];
    let currentDay = null;
    // reuse one Date object to avoid allocations
    const tmpDate = new Date(0);
    const sortedHistoryLength = sortedHistory.length;

    for (let i = 0; i < sortedHistoryLength; i++) {
        const message = sortedHistory[i];

        tmpDate.setTime(message.createdTimestamp);

        // build day key in UTC YYYY-MM-DD
        const year = tmpDate.getUTCFullYear();
        const monthVal = tmpDate.getUTCMonth() + 1; // +1 because JS months are 0-based
        const month = monthVal < 10 ? '0' + monthVal : monthVal; // pad to 2 digits.
        const dayVal = tmpDate.getUTCDate();
        const day = dayVal < 10 ? '0' + dayVal : dayVal;
        const dayKey = `${year}-${month}-${day}`;

        // when the day changes, emit header
        if (dayKey !== currentDay) {
            formattedLines.push(''); // blank line between day blocks
            formattedLines.push(`--- ${dayKey} ---`);
            currentDay = dayKey;
        }

        // format time as HH:MM (UTC)
        const hoursVal = tmpDate.getUTCHours();
        const hours = hoursVal < 10 ? '0' + hoursVal : hoursVal;
        const minutesVal = tmpDate.getUTCMinutes();
        const minutes = minutesVal < 10 ? '0' + minutesVal : minutesVal;
        const time = `${hours}:${minutes}`;

        const displayName = resolveDisplayNameForMessage(message, client);

        formattedLines.push(`${time} ${displayName}: ${message.content}`);
    }

    return formattedLines.join('\n').trim();
}

module.exports = {
    isValidMessage,
    createMinimalMessage,
    formatChatHistoryByDay,
};