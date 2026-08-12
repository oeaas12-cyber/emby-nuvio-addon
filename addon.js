// Direct Emby -> Nuvio (Stremio-protocol) addon
// Auth: Server URL + Username + Password only (no API key required)
// Run:  npm install && npm start
// Then in Nuvio: Settings > Addons > Add Addon > paste the printed manifest URL

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const DEVICE_ID = 'nuvio-emby-bridge-001';
const CLIENT_NAME = 'NuvioEmbyBridge';
const APP_VERSION = '1.0.0';

// In-memory token cache so we don't re-login on every single request
const tokenCache = new Map(); // key: `${embyUrl}|${username}` -> { token, userId, expires }

function cacheKey(embyUrl, username) {
  return `${embyUrl}|${username}`;
}

async function embyLogin(embyUrl, username, password) {
  const key = cacheKey(embyUrl, username);
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return cached;

  const authUrl = `${embyUrl.replace(/\/$/, '')}/Users/AuthenticateByName`;
  const res = await fetch(authUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': `MediaBrowser Client="${CLIENT_NAME}", Device="NuvioBridge", DeviceId="${DEVICE_ID}", Version="${APP_VERSION}"`
    },
    body: JSON.stringify({ Username: username, Pw: password })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Emby login failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const entry = {
    token: data.AccessToken,
    userId: data.User.Id,
    expires: Date.now() + 55 * 60 * 1000 // refresh ~hourly
  };
  tokenCache.set(key, entry);
  return entry;
}

async function findEmbyItemByExternalId(embyUrl, session, imdbId) {
  const url = new URL(`${embyUrl.replace(/\/$/, '')}/Users/${session.userId}/Items`);
  url.searchParams.set('Recursive', 'true');
  url.searchParams.set('Fields', 'ProviderIds,Path,MediaSources');
  url.searchParams.set('AnyProviderIdEquals', `imdb.${imdbId}`);
  url.searchParams.set('IncludeItemTypes', 'Movie,Episode');

  const res = await fetch(url.toString(), {
    headers: { 'X-Emby-Token': session.token }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return (data.Items && data.Items[0]) || null;
}

function buildManifest() {
  return {
    id: 'org.nuvio.embybridge',
    version: '1.0.0',
    name: 'Emby Direct',
    description: 'Direct integration: stream your Emby library in Nuvio using your Emby server URL, username, and password.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: true },
    config: [
      { key: 'embyUrl', type: 'text', title: 'Emby Server URL (e.g. http://192.168.1.50:8096)', required: true },
      { key: 'username', type: 'text', title: 'Emby Username', required: true },
      { key: 'password', type: 'text', title: 'Emby Password', required: true }
    ]
  };
}

const builder = new addonBuilder(buildManifest());

builder.defineStreamHandler(async (args) => {
  try {
    const cfg = args.config || {};
    if (!cfg.embyUrl || !cfg.username || !cfg.password) {
      return { streams: [] };
    }

    const session = await embyLogin(cfg.embyUrl, cfg.username, cfg.password);

    // args.id looks like "tt1234567" for movies or "tt1234567:1:2" for series episodes
    const [imdbId] = String(args.id).split(':');

    const item = await findEmbyItemByExternalId(cfg.embyUrl, session, imdbId);
    if (!item) return { streams: [] };

    const streamUrl = `${cfg.embyUrl.replace(/\/$/, '')}/Videos/${item.Id}/stream?Static=true&api_key=${session.token}`;

    return {
      streams: [
        {
          name: 'Emby',
          title: item.Name || 'Play from Emby',
          url: streamUrl,
          behaviorHints: { notWebReady: false }
        }
      ]
    };
  } catch (err) {
    console.error('Stream handler error:', err.message);
    return { streams: [] };
  }
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port }).then(({ url }) => {
  console.log(`\nEmby Direct addon running.`);
  console.log(`Local manifest URL: ${url}/manifest.json`);
  console.log(`Configure page:     ${url}/configure`);
  console.log(`\nOpen the Configure page, enter your Emby URL/username/password,`);
  console.log(`copy the generated manifest URL, and paste it into Nuvio > Settings > Addons.\n`);
});
