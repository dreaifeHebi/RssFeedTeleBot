import { XMLParser } from 'fast-xml-parser';

export default {
  async fetch(request, env, ctx) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.error('CRITICAL: TELEGRAM_BOT_TOKEN is missing in environment variables!');
      return new Response('Internal Server Error: Configuration Missing', { status: 500 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const update = await request.json();

      if (update.message && update.message.text) {
        return await handleMessage(update.message, env);
      } else if (update.callback_query) {
        return await handleCallback(update.callback_query, env);
      }
      
      return new Response('OK', { status: 200 });

    } catch (e) {
      console.error(e);
      return new Response('Error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.error('CRITICAL: TELEGRAM_BOT_TOKEN is missing in scheduled event!');
      return;
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_"
    });
    const subs = await getSubscriptions(env);

    if (subs.length === 0) {
      console.log('No subscriptions found.');
      return;
    }

    const subsByUrl = {};
    for (const sub of subs) {
      if (!subsByUrl[sub.rssUrl]) {
        subsByUrl[sub.rssUrl] = [];
      }
      subsByUrl[sub.rssUrl].push(sub);
    }

    const forwardConfigCache = new Map();

    for (const [rssUrl, subscribers] of Object.entries(subsByUrl)) {
      try {
        console.log(`Checking feed: ${rssUrl}`);
        
        let hash = 0;
        for (let i = 0; i < rssUrl.length; i++) {
          hash = ((hash << 5) - hash) + rssUrl.charCodeAt(i);
          hash |= 0;
        }
        const sentKey = `sent_guids:${hash}`;
        
        let sentGuids = new Set();
        const storedData = await env.DB.get(sentKey);
        if (storedData) {
          sentGuids = new Set(JSON.parse(storedData));
        }

        const response = await fetch(rssUrl);
        const rssText = await response.text();
        const feedRaw = parser.parse(rssText);

        let items = [];
        let feedTitle = '';

        if (feedRaw.feed && feedRaw.feed.entry) {
          feedTitle = feedRaw.feed.title;
          const entries = Array.isArray(feedRaw.feed.entry) ? feedRaw.feed.entry : [feedRaw.feed.entry];
          items = entries.map(entry => {
             let link = '';
             if (Array.isArray(entry.link)) {
                const alt = entry.link.find(l => l['@_rel'] === 'alternate');
                link = alt ? alt['@_href'] : entry.link[0]['@_href'];
             } else if (entry.link && entry.link['@_href']) {
                link = entry.link['@_href'];
             } else {
                link = entry.link;
             }
             
             return {
               title: entry.title,
               link: link,
               id: entry.id,
               pubDate: entry.published || entry.updated
             };
          });
        } else if (feedRaw.rss && feedRaw.rss.channel && feedRaw.rss.channel.item) {
          feedTitle = feedRaw.rss.channel.title;
          const rssItems = Array.isArray(feedRaw.rss.channel.item) ? feedRaw.rss.channel.item : [feedRaw.rss.channel.item];
          items = rssItems.map(item => ({
            title: item.title,
            link: item.link,
            id: (item.guid && item.guid['#text']) ? item.guid['#text'] : (item.guid || item.link),
            pubDate: item.pubDate
          }));
        }

        console.log(feedTitle);
        let newGuidsFound = false;

        if (items.length > 0) {
          for (const item of items) {
            const guid = item.id || item.link;

            if (!sentGuids.has(guid)) {
              const channelName = subscribers[0].channelName || feedTitle; 
              console.log(`New item found for ${channelName}: ${item.title}`);
              
              const message = `🔴 <b>New Update!</b>\n\n` +
                `<b>Title:</b> ${item.title}\n` +
                `<b>Source:</b> ${channelName}\n` +
                `<b>Link:</b> ${item.link}\n` +
                `<b>Date:</b> ${item.pubDate}`;

              for (const sub of subscribers) {
                let config = forwardConfigCache.get(sub.chatId);
                if (config === undefined) {
                   const rawConfig = await env.DB.get(`forward_config:${sub.chatId}`);
                   config = rawConfig ? JSON.parse(rawConfig) : null;
                   forwardConfigCache.set(sub.chatId, config);
                }

                if (config) {
                   await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, config.targetChatId, null, message);
                   
                   if (!config.onlyForward) {
                     await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, sub.chatId, sub.threadId, message);
                   }
                } else {
                   await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, sub.chatId, sub.threadId, message);
                }
              }

              sentGuids.add(guid);
              newGuidsFound = true;
            }
          }
        }

        if (newGuidsFound) {
          const guidsArray = Array.from(sentGuids).slice(-100);
          await env.DB.put(sentKey, JSON.stringify(guidsArray));
        }

      } catch (error) {
        console.error(`Error checking ${rssUrl}:`, error);
      }
    }
  }
};

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id || null;
  const text = message.text.trim();

  if (text.startsWith('/start')) {
    const welcomeMsg = `👋 <b>RSS & Social Monitor Bot</b>\n\n` +
      `I can monitor RSS feeds, X (Twitter), and YouTube channels for you.\n\n` +
      `<b>Commands:</b>\n` +
      `/add rss &lt;url&gt; - Add RSS feed\n` +
      `/add x &lt;username&gt; - Add X user\n` +
      `/del [type] &lt;name&gt; - Remove subscription\n` +
      `/list - List subscriptions\n` +
      `/set_forward - Configure forwarding\n` +
      `/help - Show help`;
    
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, welcomeMsg);
  }
  else if (text.startsWith('/help')) {
    const helpMsg = `📖 <b>Help Guide</b>\n\n` +
      `<b>1. Add Subscription</b>\n` +
      `Use <code>/add &lt;type&gt; &lt;arg&gt;</code>\n` +
      `- RSS: <code>/add rss https://example.com/feed.xml</code>\n` +
      `- X (Twitter): <code>/add x username</code>\n` +
      `- YouTube: <code>/add youtube username</code>\n\n` +
      `<b>2. Forwarding Settings</b>\n` +
      `Configure message forwarding to another channel/group:\n` +
      `<code>/set_forward &lt;target_chat_id&gt; [only_forward: true/false]</code>\n` +
      `Example: <code>/set_forward -100123456789 true</code> (Sends ONLY to target)\n` +
      `To remove: <code>/del_forward</code>\n\n` +
      `<b>3. Manage Subscriptions</b>\n` +
      `- List: <code>/list</code>\n` +
      `- Remove: <code>/del [type] &lt;name&gt;</code>\n` +
      `- ID Info: <code>/id</code>`;
      
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, helpMsg);
  }
  else if (text.startsWith('/id')) {
    let msg = `🆔 <b>Chat Info</b>\n\n` +
      `<b>Chat ID:</b> <code>${chatId}</code>`;
    
    if (threadId) {
      msg += `\n<b>Thread ID:</b> <code>${threadId}</code>`;
    }
    
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, msg);
  }
  else if (text.startsWith('/add')) {
    const parts = text.split(/\s+/);
    if (parts.length < 3) {
       await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, 
         'Usage:\n' +
         '/add rss <url>\n' +
         '/add x <username>\n' +
         '/add youtube <channel_name>'
       );
       return new Response('OK');
    }
    
    const type = parts[1].toLowerCase();
    const arg = parts[2];
    
    let channelName = arg;
    let rssUrl = '';

    if (type === 'rss') {
      rssUrl = arg;
      try {
        const urlObj = new URL(rssUrl);
        channelName = urlObj.hostname + (urlObj.pathname.length > 1 ? urlObj.pathname : '');
      } catch (e) {
        channelName = rssUrl;
      }
    } else if (type === 'x') {
      rssUrl = `${env.RSS_BASE_URL || 'https://rsshub.app'}/twitter/user/${arg}`;
      channelName = arg;
    } else if (type === 'youtube') {
      rssUrl = `${env.RSS_BASE_URL || 'https://rsshub.app'}/youtube/user/${arg}`;
      channelName = arg;
    } else {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, 'Unknown type. Use rss, x, or youtube.');
      return new Response('OK');
    }
    
    const subs = await getSubscriptions(env);
    const exists = subs.some(s => s.rssUrl === rssUrl && s.chatId === chatId && s.threadId === threadId);
    
    if (!exists) {
      subs.push({ type, channelName, rssUrl, chatId, threadId });
      await env.DB.put('subscriptions', JSON.stringify(subs));
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, `✅ Added ${type} subscription: ${channelName}`);
    } else {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, `⚠️ Subscription already exists.`);
    }
  } 
  else if (text.startsWith('/set_forward')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, 
        'Usage: /set_forward <target_chat_id> [only_forward: true/false]\n' +
        'Example: /set_forward -100123456789 true'
      );
      return new Response('OK');
    }

    const targetChatId = parseInt(parts[1]);
    const onlyForward = parts.length > 2 ? parts[2].toLowerCase() === 'true' : false;
    
    if (isNaN(targetChatId)) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, '⚠️ Invalid Target Chat ID.');
      return new Response('OK');
    }

    const config = { targetChatId, onlyForward };
    await env.DB.put(`forward_config:${chatId}`, JSON.stringify(config));
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, 
      `✅ Forwarding configured.\nTarget: ${targetChatId}\nOnly Forward: ${onlyForward}`
    );
  }
  else if (text.startsWith('/del_forward')) {
    await env.DB.delete(`forward_config:${chatId}`);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, '✅ Forwarding configuration removed.');
  }
  else if (text.startsWith('/del') || text.startsWith('/remove')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
       await sendTelegramMessage(
         env.TELEGRAM_BOT_TOKEN,
         chatId,
         threadId,
         'Usage: /del <channel_name>\n' +
         'Or: /del <type> <channel_name> (type: rss, x, youtube)'
       );
       return new Response('OK');
    }

    let type = null;
    let channelName = parts[1];
    if (parts.length >= 3) {
      const maybeType = parts[1].toLowerCase();
      if (maybeType === 'rss' || maybeType === 'x' || maybeType === 'youtube') {
        type = maybeType;
        channelName = parts[2];
      }
    }

    let subs = await getSubscriptions(env);
    const newSubs = subs.filter((s) => {
      if (s.chatId !== chatId || s.threadId !== threadId) {
        return true;
      }
      if (s.channelName !== channelName) {
        return true;
      }
      const effectiveType = s.type || inferTypeFromRssUrl(s.rssUrl);
      return type ? effectiveType !== type : false;
    });
    
    if (subs.length !== newSubs.length) {
      await env.DB.put('subscriptions', JSON.stringify(newSubs));
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        threadId,
        `🗑️ Removed ${type ? `${type} ` : ''}${channelName} from watchlist.`
      );
    } else {
       await sendTelegramMessage(
         env.TELEGRAM_BOT_TOKEN,
         chatId,
         threadId,
         `⚠️ Subscription for ${type ? `${type} ` : ''}${channelName} not found.`
       );
    }
  }
  else if (text.startsWith('/list')) {
    const subs = await getSubscriptions(env);
    const mySubs = subs.filter(s => s.chatId === chatId && s.threadId === threadId);
    
    if (mySubs.length === 0) {
       await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, '📭 No active subscriptions.');
    } else {
       const list = mySubs
         .map((s) => {
           const type = s.type || inferTypeFromRssUrl(s.rssUrl);
           return `- [${type}] ${s.channelName}`;
         })
         .join('\n');
       await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, `📋 <b>Subscriptions:</b>\n${list}`);
    }
  }
  else if (text.startsWith('/forward_to')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, 'Usage: /forward_to <target_chat_id> [target_thread_id]');
      return new Response('OK');
    }

    const targetChatId = parseInt(parts[1]);
    let targetThreadId = null;

    if (parts.length > 2) {
      targetThreadId = parseInt(parts[2]);
      if (isNaN(targetThreadId)) {
         await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, '⚠️ Invalid Target Thread ID.');
         return new Response('OK');
      }
    }

    if (isNaN(targetChatId)) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, '⚠️ Invalid Target Chat ID.');
      return new Response('OK');
    }

    const subs = await getSubscriptions(env);
    const currentSubs = subs.filter(s => s.chatId === chatId && s.threadId === threadId);

    if (currentSubs.length === 0) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, '⚠️ No subscriptions found in this chat to forward.');
      return new Response('OK');
    }

    const uuid = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const sessionId = uuid;
    
    const sessionData = {
      targetChatId,
      targetThreadId,
      sourceChatId: chatId,
      sourceThreadId: threadId,
      subMap: currentSubs.map((s) => ({
        type: s.type || inferTypeFromRssUrl(s.rssUrl),
        channelName: s.channelName,
        rssUrl: s.rssUrl
      }))
    };
    
    await env.DB.put(`fwd_session:${sessionId}`, JSON.stringify(sessionData), { expirationTtl: 3600 });

    const keyboard = {
      inline_keyboard: [
        [{ text: "🚀 Forward All", callback_data: `fwd:${sessionId}:ALL` }],
        ...currentSubs.map((s, idx) => [{ 
          text: `📺 [${s.type || inferTypeFromRssUrl(s.rssUrl)}] ${s.channelName}`, 
          callback_data: `fwd:${sessionId}:${idx}` 
        }])
      ]
    };

    const msg = `📤 <b>Forward Subscriptions</b>\n\n` +
      `<b>Target Chat ID:</b> <code>${targetChatId}</code>\n` +
      (targetThreadId ? `<b>Target Thread ID:</b> <code>${targetThreadId}</code>\n` : '') +
      `\nSelect the subscriptions you want to copy to the target chat:`;

    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, msg, keyboard);
  }

  return new Response('OK', { status: 200 });
}

async function handleCallback(callbackQuery, env) {
  const data = callbackQuery.data;
  const message = callbackQuery.message;
  const chatId = message.chat.id;
  const messageId = message.message_id;

  if (!data.startsWith('fwd:')) {
    return new Response('OK');
  }

  const parts = data.split(':');
  if (parts.length < 3) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "❌ Invalid callback data.");
    return new Response('OK');
  }

  const sessionId = parts[1];
  const action = parts[2];

  const sessionRaw = await env.DB.get(`fwd_session:${sessionId}`);
  if (!sessionRaw) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "❌ Session expired or invalid.");
    return new Response('OK');
  }

  const session = JSON.parse(sessionRaw);
  
  if (session.sourceChatId !== chatId) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "❌ This button is not for this chat.");
    return new Response('OK');
  }

  const { targetChatId, targetThreadId, subMap } = session;

  let subsToForward = [];
  if (action === 'ALL') {
    subsToForward = subMap || [];
  } else {
    const idx = parseInt(action);
    if ((subMap || [])[idx]) {
      subsToForward = [subMap[idx]];
    }
  }

  if (subsToForward.length === 0) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "⚠️ No channel selected.");
    return new Response('OK');
  }

  const subs = await getSubscriptions(env);
  let addedCount = 0;

  for (const subToForward of subsToForward) {
    const { type, channelName, rssUrl } = subToForward;
    const exists = subs.some(
      (s) => s.rssUrl === rssUrl && s.chatId === targetChatId && s.threadId === targetThreadId
    );
    
    if (!exists) {
      subs.push({ type, channelName, rssUrl, chatId: targetChatId, threadId: targetThreadId });
      addedCount++;
    }
  }

  if (addedCount > 0) {
    await env.DB.put('subscriptions', JSON.stringify(subs));
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, `✅ Forwarded ${addedCount} subscriptions!`);
    
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, session.sourceThreadId, `✅ Successfully forwarded ${addedCount} subscriptions to target.`);
    
    await env.DB.delete(`fwd_session:${sessionId}`);
  } else {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "⚠️ Channels already exist in target.");
  }

  return new Response('OK', { status: 200 });
}

async function getSubscriptions(env) {
  const data = await env.DB.get('subscriptions');
  return data ? JSON.parse(data) : [];
}

function inferTypeFromRssUrl(rssUrl = '') {
  if (rssUrl.includes('/twitter/user/')) {
    return 'x';
  }
  if (rssUrl.includes('/youtube/user/')) {
    return 'youtube';
  }
  return 'rss';
}

async function sendTelegramMessage(token, chatId, threadId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  
  if (threadId) {
    payload.message_thread_id = threadId;
  }
  
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    console.error(`Failed to send message to ${chatId} (${threadId}):`, await response.text());
  }
}

async function answerCallbackQuery(token, callbackQueryId, text) {
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  const payload = {
    callback_query_id: callbackQueryId,
    text: text
  };
  
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}
