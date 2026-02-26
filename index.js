require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes, ActivityType } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, EndBehaviorType, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const prism = require('prism-media');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const fetch = require('node-fetch');
const path = require('path');

const BOT_NAME = process.env.BOT_NAME.toLowerCase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

let audioQueue = [];
let isSpeaking = false;
let currentlyActive = false;

// Slash Command
const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Lists all /-commands of the Bot'),
  new SlashCommandBuilder().setName('status').setDescription('Replies with the status of available commands'),
  new SlashCommandBuilder().setName('setup').setDescription('Settings for the bot (e.g. language'),
  new SlashCommandBuilder().setName('join').setDescription('Bot joint dem Voice Channel'),
  new SlashCommandBuilder().setName('ai').setDescription('Answers on Questions').addStringOption(option => option.setName('question').setDescription('The actual message (feel free to chat)').setRequired(true)).addBooleanOption(option => option.setName('brutal-mode').setDescription('Answers brutally, harming and sexual')),
  new SlashCommandBuilder().setName('ada').setDescription('Bot uses Ada Satisfactory voice'),
  new SlashCommandBuilder().setName('leave').setDescription('Bot leaves Voice Channel'),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
})();

client.on('clientReady', () => {
    console.log(`Eingeloggt als ${client.user.tag}!`);

    client.user.setPresence({
        activities: [{ 
            name: `/help`, // Der Text, der angezeigt wird (z.B. "Spielt Kanäle verwalten")
            type: ActivityType.Listening // Die Art der Aktivität (Playing, Watching, Listening, Streaming, Competing)
        }],
    });

    console.log('Bot-Status wurde gesetzt.');
});

client.login(process.env.DISCORD_TOKEN);

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options } = interaction;
  const username = interaction.user.username;
  const displayName = interaction.member.displayName;

  if (commandName === 'help') {
    if (!checkCommandActive(commandName)) return interaction.reply({ content: `Command unavailable`, ephemeral: true });
    const helpEmbed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Help-Menu')
        .setURL('http://snowy.ct.ws')
        .setDescription('This is every command of the bot:')
        .addFields(
            { name: '`/help`', value: 'Shows this message.' },
            { name: '`/status`', value: 'Shows the currently available /-commands.' },
            { name: '`/join`', value: 'Bot joins your voice and you can talk to it with "hey lumi".', inline: true },
            { name: '`/ada`', value: 'Similar to /join but with ada voice (only english supported).', inline: true },
            { name: '`/leave`', value: 'Bot leaves the voice channel (also after 30s of inactivity).', inline: true },
            { name: '`/ai`', value: 'Chat with an Lumi AI on your Discord Server'},
        )
        .setTimestamp()
        .setFooter({ text: 'Requested by ' + interaction.user.username });

    await interaction.reply({ embeds: [helpEmbed] });
  } else if (commandName === 'status') {
    if (!checkCommandActive(commandName)) return interaction.reply({ content: `Command unavailable`, ephemeral: true });

    const activeStates = checkCommandActive();

    const commandFields = Object.keys(checkCommandActive()).map(cmd => {
      const data = activeStates[cmd]
      let StatusIcon = '🔴';
      if (data.active === true) {
        StatusIcon = '🟢';
      } else if (data.active === 'error') { 
          StatusIcon = '🟠'; 
      }
      const StatusText = data.message ? `${StatusIcon}\n*${data.message}*` : StatusIcon;
        return {
            name: `/${cmd}`,
            value: StatusText,
            inline: !data.message
        };
    });

    const statusEmbed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('System Status')
        .setURL('http://snowy.ct.ws')
        .setDescription('Currently available:')
        .addFields(commandFields)
        .setTimestamp()
        .setFooter({ text: 'Requested by ' + interaction.user.username });

    await interaction.reply({ embeds: [statusEmbed] });
  } else if (commandName === 'join') {
    if (!checkCommandActive(commandName)) return interaction.reply({ content: `Command unavailable`, ephemeral: true });
    const channel = interaction.member.voice.channel;
    if (!channel) return interaction.reply('❌ Du musst in einem Voice-Channel sein.');

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false
    });

    interaction.reply('🎙️ Ich höre jetzt zu. Sag: **Hey Nova**');

    const receiver = connection.receiver;

    receiver.speaking.on('start', userId => {
      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 }
      });

      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });
      decoder.on('error', (err) => {
        console.warn('Opus Decoder Error (ignored):', err.message);
      });
      const filePath = `recordings/${Date.now()}.pcm`;

      audioStream.pipe(decoder).pipe(fs.createWriteStream(filePath)).on('finish', async () => {
        const wavFile = filePath.replace('.pcm', '.wav');
        await pcmToWav(filePath, wavFile);
        
        let text = await transcribeWhisper(wavFile);
        text = text.replace(/\[.*?\]|\*.*?\*/g, '').trim();
        if (!text) {
          fs.unlinkSync(filePath);
          fs.unlinkSync(wavFile);
          return;
        }


        // Cleanup
        fs.unlinkSync(filePath);
        fs.unlinkSync(wavFile);

        if (checkForBotname(text)) return;
        if (currentlyActive) return;
        currentlyActive = true;

        const trigger = new RegExp(`^hey\\s+${BOT_NAME}[\\s,./!?:]*`, 'i');
        const question = text.replace(trigger, '').trim();

        let action = checkForAction(question)

        currentlyActive = false;
        if (action) {
          let task = question.replace(action, '').trim()
          await doAction(action, task, connection);
        } else {
          const prompt = `
            You are "Lumi AI", a Discord AI bot by Snowy. Respond naturally to a user's message.
            The user may write in any language. You MUST reply in the same language the user used. Do not use English unless the user used English.
            
            The User asked the following:
            ${question}
          `;

          let buffer = '';

          await askOllamaStream(prompt, async (token) => {
            buffer += token;

            if (
              /[.!?]\s*$/.test(buffer) &&
              buffer.length > 20
            ) {
              const textToSpeak = buffer.trim();
              buffer = '';

              try {
                const wav = await speak(textToSpeak);
                audioQueue.push(wav);
                playQueuedAudio(connection);
              } catch (err) {
                console.error('TTS Fehler:', err);
              }
            }
          });
          
          if (buffer.trim().length > 0) {
            const wav = await speak(buffer.trim());
            audioQueue.push(wav);
            playQueuedAudio(connection);
            buffer = ''; // Clear it
          }
        }
      });
    });
  } else if (commandName === 'ai') {
    if (!checkCommandActive(commandName)) return interaction.reply({ content: `Command unavailable`, ephemeral: true });
    const question = options.getString('question');
    let mode = options.getBoolean('brutal-mode');
    const userId = interaction.user.id;

    if (!question) {
      interaction.reply({ content: `Invalid Question`, ephemeral: true });
      return
    }
    if (!mode) mode = false;

    const member = interaction.guild.members.cache.get(userId);
    const serverName = interaction.guild.name;
    const serverOwnerID = await interaction.guild.members.fetch(interaction.guild.ownerId);
    const serverOwner = serverOwnerID.displayName;
    const serverMember = interaction.guild.memberCount;
    let status, atype, aname, ainfo, astat;

    if (member.presence) {
      status = member.presence.status;
      const activities = member.presence.activities;
      activities.forEach(activity => {
        atype = (typeof activity.type === 'number') ? '' : activity.type;  //e.g. "PLAYING", "LISTENING", "STREAMING", "WATCHING"
        aname = activity.name;  // name of application
        ainfo = activity.details; //e.g. songname if spotify
        astat = activity.state;
      });
    } 

    const prompt = `
      You are "Lumi AI", a Discord AI bot by Snowy. Respond naturally to a user's message.
      You have the following commands that can be used by users (DO NOT mention or use unless the user explicitly asks about it or it is strictly necessary to answer the question):
      - /help | to show all commands
      - /status | to see if a command is available
      - /setup | server settings e.g. language
      - /ai (message) | to ask the ai
      - /join | join a voice and talk with a user
      - /ada | same as /join but with ada voice from satisfactory
      - /leave | to disconnect the bot from the talk

      User info (DO NOT mention or use unless the user explicitly asks about it or it is strictly necessary to answer the question):
      - username=${username}
      - displayName=${displayName}
      - status=${status}
      - activity=${atype} - ${aname}
      - activitydetails=${ainfo} - ${astat}

      Server info (DO NOT mention or use unless the user explicitly asks about the server):
      - servername=${serverName}
      - serverowner=${serverOwner}
      - servermembercount=${serverMember}

      Address the user directly using the displayName, but do NOT invent connections or reference unrelated user or server data.

      The user may write in any language. You MUST reply in the same language the user used. Do not use English unless the user used English. Do not use the language from any other source then the user's message.

      User's message:
      ${question}
    `;

    await interaction.deferReply();
    const answer = await askOllama(prompt, mode);
    const MAX_LENGTH = 2000;
    let start = 0;

    while (start < answer.length) {
      const chunk = answer.slice(start, start + MAX_LENGTH);
      await interaction.followUp({ content: chunk });
      start += MAX_LENGTH;
    }
  } else if (commandName === 'leave') {
    if (!checkCommandActive(commandName)) return interaction.reply({ content: `Command unavailable`, ephemeral: true });
    const connection = getVoiceConnection(interaction.guild.id);

    if (!connection) {
      return interaction.reply({ content: '❌ Ich bin zurzeit in keinem Voice-Channel.' });
    }

    connection.destroy();
    interaction.reply('👋 Auf Wiedersehen!');
  } else if (commandName === 'ada') {
    if (!checkCommandActive(commandName)) return interaction.reply({ content: `Command unavailable`, ephemeral: true });
    const channel = interaction.member.voice.channel;

    if (!channel) {
      return interaction.reply({
        content: '❌ Du musst in einem Voice-Channel sein.',
        ephemeral: true
      });
    }

    await interaction.deferReply();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false
    });

    const text = 'Congratulations on purchasing this statue. It is a truly spectacular and one-off event. If you believe you have heard this message before, please examine yourself for signs of temporal anomalies.';

    const audioFile = await adaSpeak(text);

    playAudio(connection, audioFile, 0.6)

    //await adaPitchFile(audioFile)
    //  .then(() => playAudio(connection, audioFile, 0.6))
    //  .catch(console.error)
    

    interaction.editReply('🎙️ Ada was here');
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const connection = getVoiceConnection(oldState.guild.id);
  
  if (!connection) return;

  const botChannelId = connection.joinConfig.channelId;
  const channel = oldState.guild.channels.cache.get(botChannelId);

  if (channel && channel.members.size === 1) {
    
    setTimeout(() => {
        const retryChannel = oldState.guild.channels.cache.get(botChannelId);
        if (retryChannel && retryChannel.members.size === 1) {
            connection.destroy();
        }
    }, 30000); // 30000 ms = 30 seconds
  }
});

function checkCommandActive(cmd) {
  const cmd_config = JSON.parse(fs.readFileSync('./configs/cmd_config.json', 'utf8'));
  if(!cmd) {
    return cmd_config;
  } else {
    return cmd_config[cmd].active;
  }
}
function getAIModels() {
  const ai_config = JSON.parse(fs.readFileSync('./configs/ai_config.json', 'utf8'));
  return ai_config;
}

function checkForBotname(text) {
  if(text.startsWith(`hey ${BOT_NAME}`)) {
    return false;
  } else if (text.startsWith(`hey, ${BOT_NAME}`)) {
    return false;
  } else if (text.startsWith(`ey ${BOT_NAME}`)) {
    return false;
  } else if (text.startsWith(`ey, ${BOT_NAME}`)) {
    return false;
  } else {
    return true;
  }
}

function checkForAction(question) {
  if(question.toLowerCase().startsWith(`play`)) {
    return "play";
  } else if(question.toLowerCase().startsWith(`stop`)) {
    return "stop";
  } else if(question.toLowerCase().startsWith(`pause`)) {
    return "pause";
  } else if(question.toLowerCase().startsWith(`resume`)) {
    return "resume";
  } else {
    return false;
  }
}
async function doAction(action, task, connection) {
  switch (action) {
    case "play":
      if(!task) return;
      try {
        const filePath = await playSong(task);
        if (filePath) {
          audioQueue.push(filePath);
          playQueuedAudio(connection, true);
        }
      } catch (err) {
        console.error("Fehler in doAction 'play':", err);
      }
      break;
    case "stop":
      audioQueue = [];
      if (connection && connection.activePlayer) {
        cleanupAudio(connection);
      }
      break;
    case "pause":
      connection.activePlayer?.pause();
      break;
    case "resume":
      connection.activePlayer?.unpause();
      break;
  }
}
async function playSong(task) {
  return new Promise(async (resolve, reject) => {
    try {
      const outFile = path.join(__dirname, 'reply', `song-${Date.now()}`);
      const finalPath = outFile + ".wav";

      // yt-dlp Parameter:
      // "ytsearch1:"takes first search
      // -x extract audio
      // --audio-format wav konverts to .wav
      const ytDlp = spawn('yt-dlp', [
        `ytsearch1:${task}`,
        '-x',
        '--audio-format', 'wav',
        '--audio-quality', '0',
        '-o', outFile + '.%(ext)s'
      ]);

      ytDlp.stderr.on('data', (data) => {
      });

      ytDlp.on('close', (code) => {
        if (code === 0) {
          resolve(finalPath);
        } else {
          reject(new Error(`yt-dlp Fehler Code: ${code}`));
        }
      });

      ytDlp.on('error', (err) => {
        console.error("Spawning yt-dlp failed:", err);
        reject(err);
      });

    } catch (error) {
      reject(error);
    }
  });
}

// 🔹 Speech-to-Text (Whisper.cpp)
function pcmToWav(pcmFile, wavFile) {
  return new Promise((resolve, reject) => {
    exec(
      `ffmpeg -f s16le -ar 48000 -ac 1 -i ${pcmFile} ${wavFile} -y`,
      (err) => (err ? reject(err) : resolve())
    );
  });
}
function transcribeWhisper(wavFile) {
  return new Promise((resolve, reject) => {
    exec(
      `~/whisper.cpp/build/bin/whisper-cli -m ~/whisper.cpp/models/ggml-base.bin -f ${wavFile} --language en --no-timestamps`,
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim().toLowerCase());
      }
    );
  });
}

// 🔹 Ollama
async function askOllama(prompt, mode) {
  const aiModel = getAIModels()
  if(!mode) mode = false;
  const aiMode = mode ? 'brutal' : 'standard';
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: aiModel[aiMode],
      prompt,
      stream: false
    })
  });
  const data = await res.json();
  return data.response;
}
// 🔹 Ollama Stream variant
async function askOllamaStream(prompt, onChunk) {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: 'phi3',
      prompt,
      stream: true
    })
  });

  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    const text = decoder.decode(chunk);
    const lines = text.split('\n'); // Split by newline

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.response) await onChunk(data.response); // Await the callback
        if (data.done) return;
      } catch (e) {
        console.error("Fehler beim Parsen des Chunks:", e, line);
      }
    }
  }
}

// 🔹 Audio Queue to cancel interruptions
async function playQueuedAudio(connection, song) {
  if (isSpeaking) return;
  if (audioQueue.length === 0) return;

  isSpeaking = true;
  const wav = audioQueue.shift();
  let audioVolume

  if (song) {
    audioVolume = 0.4;
  } else {
    audioVolume = 0.6;
  }

  await playAudio(connection, wav, audioVolume);

  isSpeaking = false;
  playQueuedAudio(connection);
}

// 🔹 Piper TTS
function speak(text) {
  return new Promise((resolve, reject) => {
    const base = __dirname;
    const outFile = path.join(base, 'reply', `reply-${Date.now()}.wav`);
    const piperBin = path.join(base, 'piper', 'piper');
    const model = path.join(base, 'voices', 'nova.onnx');

    const { spawn } = require('child_process');
    
    const child = spawn(piperBin, [
      '--model', model,
      '--output_file', outFile
    ]);
    child.stdin.write(text);
    child.stdin.end();

    let stderrData = '';

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('Piper Fehler:', stderrData);
        return reject(new Error(`Piper Prozess beendet mit Code ${code}`));
      }

      if (!fs.existsSync(outFile)) {
        return reject(new Error('Piper fertig, aber WAV wurde nicht erstellt'));
      }

      resolve(outFile);
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

// 🔹 Ada Voice for test
async function adaSpeak(text) {
  return new Promise((resolve, reject) => {
    const base = __dirname;
    const outFile = path.join(base, 'reply', `reply-${Date.now()}.wav`);
    const piperBin = path.join(base, 'piper', 'piper');
    const model = path.join(base, 'voices', 'adav6.onnx');

    console.log('Generiere Audio:', outFile);

    const { spawn } = require('child_process');
    
    const child = spawn(piperBin, [
      '--model', model,
      '--output_file', outFile,
      '--sentence_silence', 0.2
    ]);
    child.stdin.write(text);
    child.stdin.end();

    let stderrData = '';

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('Piper Fehler:', stderrData);
        return reject(new Error(`Piper Prozess beendet mit Code ${code}`));
      }

      if (!fs.existsSync(outFile)) {
        return reject(new Error('Piper fertig, aber WAV wurde nicht erstellt'));
      }

      resolve(outFile);
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}
// 🔹 Ada Voice Pitch
function adaPitchFile(wavFile) {
  const ada_config = JSON.parse(fs.readFileSync('./configs/ada_config.json', 'utf8'));
  return new Promise((resolve, reject) => {
    const tmpFile = wavFile.replace(".wav", "_tmp.wav");
    const effectsString = ada_config.soxEffects.join(' ');
    
    const command = `sox "${wavFile}" "${tmpFile}" ${effectsString}`;

    exec(command, (err, stdout, stderr) => {
      if (err) {
        console.error("SoX Fehler:", stderr);
        return reject(err);
      }

      exec(`mv "${tmpFile}" "${wavFile}"`, (mvErr) =>
        mvErr ? reject(mvErr) : resolve()
      );
    });
  });
}

// 🔹 play Audio
function playAudio(connection, file, volume) {
  const player = createAudioPlayer();
  const resource = createAudioResource(file, {inlineVolume: true, inputType:StreamType.Arbitrary, behaviors: {maxMissedFrames: 50}});
  resource.volume.setVolume(volume);

  connection.subscribe(player);
  player.play(resource);

  connection.activePlayer = player;
  connection.currentFile = file;

  player.on(AudioPlayerStatus.Idle, () => {
    cleanupAudio(connection);
  });

  player.on('error', error => {
    console.error(`Audio Player Error: ${error.message}`);
    cleanupAudio(connection);
  });
}

function cleanupAudio(connection) {
  if (connection.currentFile && fs.existsSync(connection.currentFile)) {
    try {
      fs.unlinkSync(connection.currentFile);
    } catch (e) { console.error("Löschfehler:", e); }
    connection.currentFile = null;
  }
  if (connection.activePlayer) {
    connection.activePlayer.stop();
  }

}
