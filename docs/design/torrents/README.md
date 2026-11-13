# Torrents tab: design (not built yet)

Mock-ups drawn with the app's real HTML/CSS (`mock.js` regenerates them). Nothing here is in the app.

| Screen | File |
| --- | --- |
| Search | `t1-search-light.png` |
| Results | `t2-results-light.png`, `t2-results-dark.png` |
| Choose files before downloading | `t3-files-light.png` |
| My torrents | `t4-mine-light.png` |

## Decisions
- New sidebar item **Torrents** (magnet icon, two-tone like the others) between *Scheduled* and *Settings*, with a count of active torrents.
- Two tabs inside: **Search** and **My torrents**. The toolbar search box searches torrents on this tab.
- Results are two-line rows (name; size, seeders, peers, age, source) with a *Download* button. No column-heading row.
- Before downloading: a small window like *Add Link* with the torrent's files (tick the ones wanted), save folder, "keep sharing after the download" (**off by default**) and an upload speed limit.
- **Search sources**
  - Built in, legal: Internet Archive (search API) and a bundled list of official Linux distribution torrents (searched locally).
  - Added by the user in Settings: name + URL of a **Torznab** source (what Jackett / Prowlarr provide). VDM doesn't vouch for them and says the content is the user's responsibility.
- Engine: WebTorrent inside the main process. Test with a local tracker and two clients; real-swarm behaviour (DHT, trackers on restricted networks) needs a manual check on Windows.
- Estimate: about 4–6 hours of work.
