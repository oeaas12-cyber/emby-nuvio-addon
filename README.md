# Emby Direct

A Nuvio / Stremio addon that turns your Emby server into browsable catalogs and streams.

- One catalog per Emby movie and TV library, with genre filters
- "Recently Added" rows and search
- Full episode lists for series
- Every copy of a title (e.g. 1080p and 4K libraries) offered as a separate stream, with subtitles
- Works with IMDb (`tt…`), TMDB (`tmdb:…`) and Emby-only items

## Use it

Open the configure page, connect with your Emby server URL and either your
username/password or a user ID + access token, choose libraries, and install the
generated URL in Nuvio (Settings → Addons) or Stremio.

The generated install URL contains your Emby access token. Keep it private.
Your password is only used once to obtain that token and is never stored.

## Run locally

```bash
npm install
npm start
```

Then open http://127.0.0.1:7010/configure. Set `PORT` to change the port.

## Deploy to BeamUp

```bash
beamup config a.baby-beamup.club <github-username>
beamup init emby-direct
git push beamup HEAD:master
```
