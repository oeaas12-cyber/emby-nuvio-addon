// Direct Emby -> Nuvio / Stremio addon
// - One catalog per Emby movie/TV library, plus "Recently Added" and search
// - Meta with full episode lists for series
// - Streams for IMDb (tt…) and TMDB (tmdb:…) ids, and for Emby-only items
//
// Config lives in the URL path as base64 JSON, so every install gets its
// own manifest listing its own libraries:
//   /<base64 {"embyUrl","userId","accessToken","libs"?}>/manifest.json
// Run: npm install && npm start, then open http://127.0.0.1:7010/configure

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

const APP_VERSION = '2.0.0';
const CLIENT_NAME = 'NuvioEmbyBridge';
const DEVICE_ID = 'nuvio-emby-bridge-001';
const PAGE_SIZE = 100;

// --- Config ------------------------------------------------------------

function encodeConfig(cfg) {
  return Buffer.from(JSON.stringify(cfg)).toString('base64url');
}

// Accepts our own keys and StreamBridge-style keys (serverUrl), so an
// existing StreamBridge config string can be reused as-is.
function decodeConfig(str) {
  try {
    const raw = JSON.parse(Buffer.from(decodeURIComponent(str), 'base64').toString('utf8'));
    const cfg = {
      embyUrl: raw.embyUrl || raw.serverUrl,
      userId: raw.userId,
      accessToken: raw.accessToken,
      libs: Array.isArray(raw.libs) ? raw.libs.map(String) : null
    };
    if (!cfg.embyUrl || !cfg.userId || !cfg.accessToken) return null;
    return cfg;
  } catch (e) {
    return null;
  }
}

// Every Emby server accepts the /emby prefix, and some hosted servers only
// accept API calls through it, so always normalize to it.
function embyBase(embyUrl) {
  let trimmed = String(embyUrl).trim().replace(/\/+$/, '').replace(/\/web(\/.*)?$/i, '');
  if (!/^https?:\/\//i.test(trimmed)) trimmed = 'https://' + trimmed;
  return /\/emby$/i.test(trimmed) ? trimmed : trimmed + '/emby';
}

// --- Emby API ------------------------------------------------------------

async function embyGet(cfg, apiPath, params) {
  const url = new URL(embyBase(cfg.embyUrl) + apiPath);
  Object.keys(params || {}).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]);
  });
  const res = await fetch(url, { headers: { 'X-Emby-Token': cfg.accessToken, Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(function () { return ''; });
    throw new Error('Emby GET ' + apiPath + ' failed (' + res.status + '): ' + text.slice(0, 200));
  }
  return res.json();
}

// Only used by the configure page: exchange username/password for a token
// once, so the install URL never carries the password and we never log in
// per request (which is what caused the 401/lockout bursts before).
async function embyLogin(embyUrl, username, password) {
  const authHeader = 'MediaBrowser Client="' + CLIENT_NAME + '", Device="NuvioBridge", DeviceId="' + DEVICE_ID + '", Version="' + APP_VERSION + '"';
  const res = await fetch(embyBase(embyUrl) + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': authHeader },
    body: JSON.stringify({ Username: username, Pw: password || '' })
  });
  // Phone keyboards and password managers sometimes add a stray space;
  // retry once without it before giving up.
  if (res.status === 401 && password && password !== password.trim()) {
    return embyLogin(embyUrl, username, password.trim());
  }
  if (res.status === 401) {
    throw new Error('Emby rejected this username or password. Check them in the Emby app, or use the Access token tab.');
  }
  if (!res.ok) {
    const text = await res.text().catch(function () { return ''; });
    throw new Error('Emby login failed (' + res.status + '): ' + (text || res.statusText));
  }
  const data = await res.json();
  return { userId: data.User.Id, accessToken: data.AccessToken };
}

// Small TTL cache so manifest/catalog requests don't refetch libraries and
// genres every time.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value: value, expires: Date.now() + ttlMs });
  return value;
}

function cfgKey(cfg) {
  return cfg.embyUrl + '|' + cfg.userId;
}

function libraryKind(lib) {
  const t = (lib.CollectionType || '').toLowerCase();
  if (t === 'movies') return { type: 'movie', itemType: 'Movie' };
  if (t === 'tvshows') return { type: 'series', itemType: 'Series' };
  return null; // playlists, boxsets, music, photos, mixed folders
}

async function getLibraries(cfg) {
  return cached('libs|' + cfgKey(cfg), 10 * 60 * 1000, async function () {
    const data = await embyGet(cfg, '/Users/' + cfg.userId + '/Views', {});
    return (data.Items || [])
      .map(function (lib) {
        const kind = libraryKind(lib);
        return kind ? { id: lib.Id, name: lib.Name, type: kind.type, itemType: kind.itemType } : null;
      })
      .filter(Boolean);
  });
}

async function getGenres(cfg, lib) {
  return cached('genres|' + cfgKey(cfg) + '|' + lib.id, 60 * 60 * 1000, async function () {
    const data = await embyGet(cfg, '/Genres', {
      UserId: cfg.userId,
      ParentId: lib.id,
      IncludeItemTypes: lib.itemType,
      Recursive: 'true',
      SortBy: 'SortName'
    });
    return (data.Items || []).map(function (g) { return g.Name; });
  });
}

// --- Manifest ------------------------------------------------------------

async function buildManifest(cfg) {
  let libs = await getLibraries(cfg);
  if (cfg.libs && cfg.libs.length) {
    libs = libs.filter(function (l) { return cfg.libs.indexOf(l.id) !== -1; });
  }

  const genreLists = await Promise.allSettled(libs.map(function (l) { return getGenres(cfg, l); }));

  const catalogs = [];
  const types = new Set(libs.map(function (l) { return l.type; }));

  if (types.has('movie')) catalogs.push({ type: 'movie', id: 'emby-recent-movie', name: 'Emby: Recently Added', extra: [{ name: 'skip' }] });
  if (types.has('series')) catalogs.push({ type: 'series', id: 'emby-recent-series', name: 'Emby: Recently Added', extra: [{ name: 'skip' }] });

  libs.forEach(function (lib, i) {
    const genres = genreLists[i].status === 'fulfilled' ? genreLists[i].value : [];
    const genreExtra = { name: 'genre', isRequired: false };
    if (genres.length) genreExtra.options = genres;
    catalogs.push({
      type: lib.type,
      id: 'emby-lib-' + lib.id,
      name: 'Emby: ' + lib.name,
      extra: [genreExtra, { name: 'skip' }]
    });
  });

  // Search-only catalogs: hidden from the home screen, used by Nuvio's
  // search page.
  types.forEach(function (type) {
    catalogs.push({ type: type, id: 'emby-search-' + type, name: 'Emby', extra: [{ name: 'search', isRequired: true }] });
  });

  // Unique id per server+user so two installs don't replace each other.
  const suffix = crypto.createHash('sha1').update(cfgKey(cfg)).digest('hex').slice(0, 8);

  return {
    id: 'org.nuvio.embydirect.' + suffix,
    version: APP_VERSION,
    name: 'Emby Direct',
    description: 'Browse and stream your Emby libraries.',
    logo: 'https://raw.githubusercontent.com/MediaBrowser/Emby.Resources/master/images/Logos/logoicon.png',
    resources: [
      'catalog',
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['emby:', 'tt'] },
      { name: 'stream', types: ['movie', 'series'], idPrefixes: ['emby:', 'tt', 'tmdb:'] }
    ],
    types: ['movie', 'series'],
    idPrefixes: ['emby:', 'tt', 'tmdb:'],
    catalogs: catalogs,
    behaviorHints: { configurable: true, configurationRequired: false }
  };
}

// --- Item -> Stremio meta -------------------------------------------------

function imageUrl(cfg, itemId, tag, type, maxWidth) {
  if (!tag) return undefined;
  return embyBase(cfg.embyUrl) + '/Items/' + itemId + '/Images/' + (type || 'Primary') + '?tag=' + tag + '&maxWidth=' + (maxWidth || 500) + '&quality=90';
}

function imdbOf(item) {
  const ids = item.ProviderIds || {};
  const imdb = ids.Imdb || ids.IMDB || ids.imdb;
  return imdb && /^tt\d+$/.test(imdb) ? imdb : null;
}

function metaId(item) {
  return imdbOf(item) || 'emby:' + item.Id;
}

const ITEM_FIELDS = 'ProviderIds,Overview,Genres,ProductionYear,CommunityRating,OfficialRating,RunTimeTicks,PremiereDate,EndDate,Status';

function toMeta(cfg, item) {
  const tags = item.ImageTags || {};
  const meta = {
    id: metaId(item),
    type: item.Type === 'Series' ? 'series' : 'movie',
    name: item.Name,
    poster: imageUrl(cfg, item.Id, tags.Primary, 'Primary', 400),
    background: imageUrl(cfg, item.Id, item.BackdropImageTags && item.BackdropImageTags[0], 'Backdrop', 1280),
    logo: imageUrl(cfg, item.Id, tags.Logo, 'Logo', 600),
    description: item.Overview,
    genres: item.Genres || [],
    imdbRating: item.CommunityRating ? item.CommunityRating.toFixed(1) : undefined,
    releaseInfo: item.ProductionYear ? String(item.ProductionYear) : undefined,
    runtime: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) + ' min' : undefined
  };
  if (item.Type === 'Series' && item.ProductionYear) {
    const endYear = item.EndDate ? new Date(item.EndDate).getUTCFullYear() : null;
    meta.releaseInfo = item.ProductionYear + '-' + (item.Status === 'Ended' && endYear ? endYear : '');
  }
  return meta;
}

// --- Catalogs -------------------------------------------------------------

async function handleCatalog(cfg, type, id, extra) {
  const itemType = type === 'series' ? 'Series' : 'Movie';
  const params = {
    Recursive: 'true',
    IncludeItemTypes: itemType,
    Fields: ITEM_FIELDS,
    EnableImageTypes: 'Primary,Backdrop,Logo',
    StartIndex: String(parseInt(extra.skip, 10) || 0),
    Limit: String(PAGE_SIZE)
  };

  if (id.indexOf('emby-lib-') === 0) {
    params.ParentId = id.slice('emby-lib-'.length);
    params.SortBy = 'SortName';
    params.SortOrder = 'Ascending';
    if (extra.genre) params.Genres = extra.genre;
  } else if (id.indexOf('emby-recent-') === 0) {
    params.SortBy = 'DateCreated,SortName';
    params.SortOrder = 'Descending';
  } else if (id.indexOf('emby-search-') === 0) {
    if (!extra.search) return { metas: [] };
    params.SearchTerm = extra.search;
    params.Limit = '50';
  } else {
    return { metas: [] };
  }

  // Recently Added / search should respect the libraries the user picked.
  if (!params.ParentId && cfg.libs && cfg.libs.length) {
    const libs = (await getLibraries(cfg)).filter(function (l) {
      return l.type === type && cfg.libs.indexOf(l.id) !== -1;
    });
    if (!libs.length) return { metas: [] };
    params.ParentId = libs.map(function (l) { return l.id; }).join(',');
  }

  const data = await embyGet(cfg, '/Users/' + cfg.userId + '/Items', params);

  // The same title often lives in several libraries (e.g. "Movies" and
  // "Movies - 4K"); show it once.
  const seen = new Set();
  const metas = [];
  (data.Items || []).forEach(function (item) {
    const m = toMeta(cfg, item);
    if (seen.has(m.id)) return;
    seen.add(m.id);
    metas.push(m);
  });
  return { metas: metas };
}

// --- Lookups by external id -----------------------------------------------

// Parses "tt123", "tt123:1:2", "tmdb:123", "tmdb:123:1:2", "emby:456".
function parseId(id) {
  const parts = String(id).split(':');
  if (parts[0] === 'emby') return { emby: parts[1] };
  if (parts[0] === 'tmdb') return { provider: 'tmdb', value: parts[1], season: parts[2], episode: parts[3] };
  if (/^tt\d+$/.test(parts[0])) return { provider: 'imdb', value: parts[0], season: parts[1], episode: parts[2] };
  return null;
}

async function findByProviderId(cfg, provider, value, itemType) {
  const data = await embyGet(cfg, '/Users/' + cfg.userId + '/Items', {
    Recursive: 'true',
    IncludeItemTypes: itemType,
    AnyProviderIdEquals: provider + '.' + value,
    Fields: ITEM_FIELDS + ',MediaSources'
  });
  // Some Emby versions ignore AnyProviderIdEquals and return everything, so
  // double-check the id really matches.
  return (data.Items || []).filter(function (item) {
    const ids = item.ProviderIds || {};
    return Object.keys(ids).some(function (k) {
      return k.toLowerCase() === provider && String(ids[k]) === String(value);
    });
  });
}

async function getEpisodes(cfg, seriesId, season) {
  const data = await embyGet(cfg, '/Shows/' + seriesId + '/Episodes', {
    UserId: cfg.userId,
    Season: season,
    Fields: 'Overview,PremiereDate,MediaSources,ProviderIds'
  });
  return data.Items || [];
}

// --- Meta -----------------------------------------------------------------

async function handleMeta(cfg, type, id) {
  const parsed = parseId(id);
  if (!parsed) return { meta: null };

  let item = null;
  if (parsed.emby) {
    item = await embyGet(cfg, '/Users/' + cfg.userId + '/Items/' + parsed.emby, { Fields: ITEM_FIELDS });
  } else {
    const matches = await findByProviderId(cfg, parsed.provider, parsed.value, type === 'series' ? 'Series' : 'Movie');
    item = matches[0] || null;
  }
  if (!item) return { meta: null };

  const meta = toMeta(cfg, item);
  if (item.Type === 'Series') {
    const imdb = imdbOf(item);
    const episodes = await getEpisodes(cfg, item.Id);
    meta.videos = episodes
      .filter(function (ep) { return ep.IndexNumber != null; })
      .map(function (ep) {
        const season = ep.ParentIndexNumber != null ? ep.ParentIndexNumber : 1;
        return {
          // With an IMDb id, other stream addons can also resolve the
          // episode; otherwise fall back to the Emby episode id.
          id: imdb ? imdb + ':' + season + ':' + ep.IndexNumber : 'emby:' + ep.Id,
          title: ep.Name,
          season: season,
          episode: ep.IndexNumber,
          released: ep.PremiereDate || new Date(0).toISOString(),
          overview: ep.Overview,
          thumbnail: imageUrl(cfg, ep.Id, ep.ImageTags && ep.ImageTags.Primary, 'Primary', 500)
        };
      });
  }
  return { meta: meta };
}

// --- Streams --------------------------------------------------------------

function qualityLabel(height, width) {
  if (height >= 1600 || width >= 3200) return '4K';
  if (height >= 900 || width >= 1800) return '1080p';
  if (height >= 600 || width >= 1200) return '720p';
  return height ? height + 'p' : 'SD';
}

function formatSize(bytes) {
  if (!bytes) return null;
  const gb = bytes / Math.pow(1024, 3);
  return gb >= 1 ? gb.toFixed(1) + ' GB' : Math.round(bytes / Math.pow(1024, 2)) + ' MB';
}

function toStreams(cfg, item) {
  const base = embyBase(cfg.embyUrl);
  return (item.MediaSources || []).map(function (ms) {
    const mediaStreams = ms.MediaStreams || [];
    const video = mediaStreams.find(function (s) { return s.Type === 'Video'; }) || {};
    const audio = mediaStreams.find(function (s) { return s.Type === 'Audio' && s.IsDefault; }) ||
      mediaStreams.find(function (s) { return s.Type === 'Audio'; }) || {};
    const label = qualityLabel(video.Height || 0, video.Width || 0);
    const container = (ms.Container || 'mkv').split(',')[0];

    const details = [
      [video.VideoRange && video.VideoRange !== 'SDR' ? video.VideoRange : null, (video.Codec || '').toUpperCase()].filter(Boolean).join(' • '),
      audio.DisplayTitle,
      [container.toUpperCase(), formatSize(ms.Size)].filter(Boolean).join(' • ')
    ].filter(Boolean);

    const subtitles = mediaStreams
      .filter(function (s) { return s.Type === 'Subtitle' && s.IsTextSubtitleStream; })
      .map(function (s) {
        return {
          id: item.Id + '-' + ms.Id + '-' + s.Index,
          lang: s.Language || 'und',
          url: base + '/Videos/' + item.Id + '/' + ms.Id + '/Subtitles/' + s.Index + '/Stream.srt?api_key=' + cfg.accessToken
        };
      });

    return {
      name: 'Emby\n' + label,
      description: (ms.Name && ms.Name !== item.Name ? ms.Name + '\n' : '') + details.join('\n'),
      url: base + '/Videos/' + item.Id + '/stream.' + container +
        '?MediaSourceId=' + encodeURIComponent(ms.Id) + '&Static=true&api_key=' + cfg.accessToken + '&DeviceId=' + DEVICE_ID,
      subtitles: subtitles,
      behaviorHints: {
        notWebReady: !(container === 'mp4' && video.Codec === 'h264'),
        bingeGroup: 'emby-' + label,
        filename: ms.Path ? path.basename(ms.Path) : undefined,
        videoSize: ms.Size || undefined
      },
      _height: video.Height || 0
    };
  });
}

async function handleStream(cfg, type, id) {
  const parsed = parseId(id);
  if (!parsed) return { streams: [] };

  let items = [];
  if (parsed.emby) {
    items = [await embyGet(cfg, '/Users/' + cfg.userId + '/Items/' + parsed.emby, { Fields: 'MediaSources' })];
  } else if (type === 'series' || parsed.season) {
    if (!parsed.season || !parsed.episode) return { streams: [] };
    // A show can exist in several libraries (e.g. "TV" and "TV - 4K");
    // collect the episode from each copy.
    const shows = await findByProviderId(cfg, parsed.provider, parsed.value, 'Series');
    const perShow = await Promise.all(shows.map(function (show) {
      return getEpisodes(cfg, show.Id, parsed.season).catch(function () { return []; });
    }));
    const episode = Number(parsed.episode);
    perShow.forEach(function (eps) {
      eps.forEach(function (ep) {
        const end = ep.IndexNumberEnd || ep.IndexNumber;
        if (ep.IndexNumber <= episode && episode <= end) items.push(ep);
      });
    });
  } else {
    items = await findByProviderId(cfg, parsed.provider, parsed.value, 'Movie');
  }

  const streams = [].concat.apply([], items.map(function (item) { return toStreams(cfg, item); }));
  streams.sort(function (a, b) { return b._height - a._height; });
  streams.forEach(function (s) { delete s._height; });
  return { streams: streams };
}

// --- HTTP -----------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

function sendJson(res, body, maxAge) {
  res.setHeader('Cache-Control', 'max-age=' + (maxAge || 0));
  res.json(body);
}

// Parses Stremio's extra segment, e.g. "genre=Action&skip=100".
function parseExtra(str) {
  const out = {};
  if (!str) return out;
  new URLSearchParams(str).forEach(function (v, k) { out[k] = v; });
  return out;
}

const configurePage = path.join(__dirname, 'configure.html');
// BeamUp's Cloudflare caches pages for hours unless told not to, which
// kept serving old configure pages after a deploy.
app.get(['/', '/configure', '/:cfg/configure'], function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(configurePage, { cacheControl: false, etag: false, lastModified: false });
});

// Configure page backend: log in (or validate a token) and list libraries.
app.post('/api/connect', async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const body = req.body || {};
    if (!body.embyUrl) throw new Error('Server URL is required');
    let auth;
    if (body.accessToken && body.userId) {
      auth = { userId: body.userId, accessToken: body.accessToken };
    } else if (body.username) {
      auth = await embyLogin(body.embyUrl, body.username, body.password);
    } else {
      throw new Error('Enter a username and password, or a user ID and access token');
    }
    const cfg = { embyUrl: body.embyUrl, userId: auth.userId, accessToken: auth.accessToken };
    const info = await embyGet(cfg, '/System/Info', {});
    cache.delete('libs|' + cfgKey(cfg));
    const libraries = await getLibraries(cfg);
    res.json({ embyUrl: body.embyUrl, userId: auth.userId, accessToken: auth.accessToken, serverName: info.ServerName, libraries: libraries });
  } catch (err) {
    res.status(400).json({ err: err.message });
  }
});

app.get('/manifest.json', function (req, res) {
  // Unconfigured manifest so the addon can be "installed" to reach the
  // configure page.
  sendJson(res, {
    id: 'org.nuvio.embydirect',
    version: APP_VERSION,
    name: 'Emby Direct',
    description: 'Browse and stream your Emby libraries. Configure first.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: true }
  });
});

app.get('/:cfg/manifest.json', async function (req, res) {
  const cfg = decodeConfig(req.params.cfg);
  if (!cfg) return res.status(400).json({ err: 'Invalid config' });
  try {
    sendJson(res, await buildManifest(cfg), 300);
  } catch (err) {
    console.error('Manifest error:', err.message);
    res.status(502).json({ err: err.message });
  }
});

// /:cfg/(catalog|meta|stream)/:type/:id[/:extra].json
app.get(/^\/([^/]+)\/(catalog|meta|stream)\/(movie|series)\/([^/]+?)(?:\/([^/]+?))?\.json$/, async function (req, res) {
  const cfg = decodeConfig(req.params[0]);
  const resource = req.params[1];
  const type = req.params[2];
  const id = decodeURIComponent(req.params[3]);
  const extra = parseExtra(req.params[4] && decodeURIComponent(req.params[4]));
  if (!cfg) return res.status(400).json({ err: 'Invalid config' });

  try {
    if (resource === 'catalog') return sendJson(res, await handleCatalog(cfg, type, id, extra), 300);
    if (resource === 'meta') return sendJson(res, await handleMeta(cfg, type, id), 600);
    return sendJson(res, await handleStream(cfg, type, id), 60);
  } catch (err) {
    console.error(resource + ' error (' + type + '/' + id + '):', err.message);
    const empty = resource === 'catalog' ? { metas: [] } : resource === 'meta' ? { meta: null } : { streams: [] };
    sendJson(res, empty, 0);
  }
});

module.exports = { app, encodeConfig, decodeConfig, parseId };

if (require.main === module) {
  const port = process.env.PORT || 7010;
  app.listen(port, function () {
    console.log('');
    console.log('Emby Direct addon running.');
    console.log('Configure page: http://127.0.0.1:' + port + '/configure');
    console.log('');
  });
}
