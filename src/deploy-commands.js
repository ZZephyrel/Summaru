import { DISCORD_TOKEN, CLIENT_ID, TEST_GUILD_ID, MAX_MESSAGES, MAX_DAYS, MAX_HOURS } from './config.js';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
    new SlashCommandBuilder()
        .setName('summarize')
        .setDescription('Summarize messages in the current channel.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('amount')
                .setDescription('Summarize the last X messages.')
                .addIntegerOption(option =>
                    option.setName('count')
                        .setDescription(`Number of past messages to summarize (max ${MAX_MESSAGES})`)
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(MAX_MESSAGES))
                .addStringOption(option =>
                    option.setName('instructions')
                        .setDescription('Special instructions for the summary.')
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('public')
                        .setDescription('Share the summary publicly? (Default: False)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('days')
                .setDescription('Summarize messages from the past X days.')
                .addNumberOption(option =>
                    option.setName('duration')
                        .setDescription(`Number of past days to summarize (max ${MAX_DAYS} days, up to ${MAX_MESSAGES} messages)`)
                        .setRequired(true)
                        .setMinValue(0.01)
                        .setMaxValue(MAX_DAYS))
                .addStringOption(option =>
                    option.setName('instructions')
                        .setDescription('Special instructions for the summary.')
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('public')
                        .setDescription('Share the summary publicly? (Default: False)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('hours')
                .setDescription('Summarize messages from the past X hours.')
                .addNumberOption(option =>
                    option.setName('duration')
                        .setDescription(`Number of past hours to summarize (max ${MAX_HOURS} hours, up to ${MAX_MESSAGES} messages)`)
                        .setRequired(true)
                        .setMinValue(0.01)
                        .setMaxValue(MAX_HOURS))
                .addStringOption(option =>
                    option.setName('instructions')
                        .setDescription('Special instructions for the summary.')
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('public')
                        .setDescription('Share the summary publicly? (Default: False)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('since_last')
                .setDescription('Summarize everything since you last spoke in this channel.')
                .addStringOption(option =>
                    option.setName('instructions')
                        .setDescription('Special instructions for the summary.')
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('public')
                        .setDescription('Share the summary publicly? (Default: False)')
                        .setRequired(false))),
    new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask the AI for anything, with optional chat context.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('now')
                .setDescription('Make a request without providing any chat history.')
                .addStringOption(option =>
                    option.setName('request')
                        .setDescription('Your question or instruction for the AI.')
                        .setRequired(true))
                .addBooleanOption(option =>
                    option.setName('public')
                        .setDescription('Share the response publicly? (Default: False)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('amount')
                .setDescription('Make a request based on the last X messages.')
                .addIntegerOption(option =>
                    option.setName('count')
                        .setDescription(`Number of messages to use as context (max ${MAX_MESSAGES})`)
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(MAX_MESSAGES))
                .addStringOption(option =>
                    option.setName('request')
                        .setDescription('Your question or instruction for the AI.')
                        .setRequired(true))
                .addBooleanOption(option =>
                    option.setName('public')
                        .setDescription('Share the response publicly? (Default: False)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('days')
                .setDescription('Make a request based on messages from the past X days.')
                .addNumberOption(option =>
                    option.setName('duration')
                        .setDescription(`Number of past days to use as context (max ${MAX_DAYS} days, up to ${MAX_MESSAGES} messages)`)
                        .setRequired(true)
                        .setMinValue(0.01)
                        .setMaxValue(MAX_DAYS))
                .addStringOption(option =>
                    option.setName('request')
                        .setDescription('Your question or instruction for the AI.')
                        .setRequired(true))
                .addBooleanOption(option =>
                    option.setName('public')
                        .setDescription('Share the response publicly? (Default: False)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('hours')
                .setDescription('Make a request based on messages from the past X hours.')
                .addNumberOption(option =>
                    option.setName('duration')
                        .setDescription(`Number of past hours to use as context (max ${MAX_HOURS} hours, up to ${MAX_MESSAGES} messages)`)
                        .setRequired(true)
                        .setMinValue(0.01)
                        .setMaxValue(MAX_HOURS))
                .addStringOption(option =>
                    option.setName('request')
                        .setDescription('Your question or instruction for the AI.')
                        .setRequired(true))
                .addBooleanOption(option =>
                    option.setName('public')
                        .setDescription('Share the response publicly? (Default: False)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('since_last')
                .setDescription('Make a request based on everything since your last message.')
                .addStringOption(option =>
                    option.setName('request')
                        .setDescription('Your question or instruction for the AI.')
                        .setRequired(true))
                .addBooleanOption(option =>
                    option.setName('public')
                        .setDescription('Share the response publicly? (Default: False)')
                        .setRequired(false)))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        if (TEST_GUILD_ID) { // Provide this env variable if you want to deploy on a single test server.
            await rest.put(
                Routes.applicationGuildCommands(CLIENT_ID, TEST_GUILD_ID),
                { body: commands },
            );
            console.log(`Successfully reloaded application (/) commands for guild ${TEST_GUILD_ID}.`);
        } else {
            await rest.put(
                Routes.applicationCommands(CLIENT_ID),
                { body: commands },
            );
            console.log('Successfully reloaded global application (/) commands.');
        }
    } catch (error) {
        console.error(error);
    }
})();