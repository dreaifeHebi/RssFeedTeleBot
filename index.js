const { XMLParser } = require('fast-xml-parser');

module.exports = {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const update = await request.json();
      if (!update.message || !update.message.text) {
        return new Response('OK', { status: 200 });
      }

      const message = update.message;
      const chatId = message.chat.id;
      const threadId = message.message_thread_id || null;
      const text = message.text.trim();
      
      if (text.startsWith('/add')) {
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
           await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, 'Usage: /add <channel_name>');
           return new Response('OK');
        }
        
        const channelName = parts[1];
        const rssUrl = (env.RSS_BASE_URL || 'https://rss.dreaife.tokyo/youtube/live/') + channelName;
        
        const subs = await getSubscriptions(env);
        const exists = subs.some(s => s.channelName === channelName && s.chatId === chatId && s.threadId === threadId);
        
        if (!exists) {
          subs.push({ channelName, rssUrl, chatId, threadId });
          await env.DB.put('subscriptions', JSON.stringify(subs));
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, `✅ Added ${channelName} to watchlist.`);
        } else {
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, `⚠️ ${channelName} is already in the watchlist.`);
        }
      } 
      else if (text.startsWith('/del') || text.startsWith('/remove')) {
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
           await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, 'Usage: /del <channel_name>');
           return new Response('OK');
        }
        
        const channelName = parts[1];
        let subs = await getSubscriptions(env);
        const newSubs = subs.filter(s => !(s.channelName === channelName && s.chatId === chatId && s.threadId === threadId));
        
        if (subs.length !== newSubs.length) {
          await env.DB.put('subscriptions', JSON.stringify(newSubs));
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, `🗑️ Removed ${channelName} from watchlist.`);
        } else {
           await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, `⚠️ Subscription for ${channelName} not found.`);
        }
      }
      else if (text.startsWith('/list')) {
        const subs = await getSubscriptions(env);
        const mySubs = subs.filter(s => s.chatId === chatId && s.threadId === threadId);
        
        if (mySubs.length === 0) {
           await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, '📭 No active subscriptions.');
        } else {
           const list = mySubs.map(s => `- ${s.channelName}`).join('\n');
           await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, threadId, `📋 <b>Subscriptions:</b>\n${list}`);
        }
      }
      
      return new Response('OK', { status: 200 });

    } catch (e) {
      console.error(e);
      return new Response('Error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
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

    for (const [rssUrl, subscribers] of Object.entries(subsByUrl)) {
      try {
        console.log(`Checking feed: ${rssUrl}`);
        
        const channelName = subscribers[0].channelName;
        const sentKey = `sent_guids:${channelName}`;
        
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
          // Atom (YouTube)
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
          // RSS 2.0
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
              console.log(`New live found for ${channelName}: ${item.title}`);
              
              const message = `🔴 <b>YouTube Live Detected!</b>\n\n` +
                `<b>Title:</b> ${item.title}\n` +
                `<b>Channel:</b> ${channelName}\n` +
                `<b>Link:</b> ${item.link}\n` +
                `<b>Date:</b> ${item.pubDate}`;

              for (const sub of subscribers) {
                await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, sub.chatId, sub.threadId, message);
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

async function getSubscriptions(env) {
  const data = await env.DB.get('subscriptions');
  return data ? JSON.parse(data) : [];
}

async function sendTelegramMessage(token, chatId, threadId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  
  if (threadId) {
    payload.message_thread_id = threadId;
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
