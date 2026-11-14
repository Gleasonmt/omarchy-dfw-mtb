# Reviewer notes

What this plugin trusts, where each boundary is enforced, and the test that proves it. Line numbers drift, so
functions are named instead.

## What it is

A bar widget (`Panel.qml`) with its logic in `Model.js`, and two small scripts:

- `fetch.sh` downloads one URL to a cache file;
- `notify.sh` sends one notification once.

There is no installer, no sudo and no manual setup, and nothing it downloads is ever run. The plugin is written by
the person who runs DFW MTB Trail Hub, the site whose public API it reads.

## Threat model

| Threat | Boundary | Code | Test |
|---|---|---|---|
| **A compromised or hostile dfwmtbtrailhub.com** sends huge, deep or odd JSON | Downloads are capped (2 MB list, 500 KB changes, 200 KB per trail, 4 KB location), with a 15 s deadline and HTTPS only, redirects included. Each field is cut to a set length and each list to a set count. Trail IDs must match `^[a-z0-9][a-z0-9-]{0,79}$`. Statuses, conditions, difficulty levels and hours come from fixed lists. | `fetch.sh`; `Model.js` `parseTrails`, `parseChanges`, `parseDetail`, `slug`, `text` | `tests/fetch.test.mjs` (caps, `--proto`, `--proto-redir`); `tests/model.test.mjs` ("drops what it can't trust", "caps every field", "parseDetail") |
| …the same, **sends links** | A link is used only if it is on `https://dfwmtbtrailhub.com/` with no quotes, spaces or angle brackets; otherwise it is rebuilt from the trail ID. The panel opens nothing else. | `Model.js` `siteUrl`; `Panel.qml` `openUrl` | "drops what it can't trust" (`javascript:`, other hosts, look-alike hosts, quotes) |
| …the same, **puts markup in names** | Names are drawn as plain text (`textFormat: Text.PlainText` on every text). In notifications, `<`, `>` and `&` are swapped for look-alikes, because Omarchy's notification service decodes entities before drawing. | `Model.js` `plainText`, `alertText` | "alert text: … no markup can survive"; "Omarchy's notification markup draws alert text as plain text" (runs the stock `Markup.js` where Omarchy is installed) |
| …the same, **floods status changes** | Only changes that appear while the widget runs are announced. Changes dated over 10 minutes ahead are ignored. Each update sends at most 3 notifications, then one summary. Every bar records each change once, under a lock (`notify.sh`), and records are removed after 60 days. | `Model.js` `alertsDue`, `alertBatch`; `Panel.qml` `checkAlerts`, `markSeen`; `notify.sh` | "alerts: only changes not seen yet…"; "a change dated in the future… a flood is three alerts and one summary"; `tests/notify.test.mjs` (once, concurrent bars, killed mid-send) |
| **Another account on the machine** reads files or process arguments | Cache and state files are 0600 in 0700 folders, whatever the umask. Process arguments carry only public trail data (names, IDs, links). The user's location is never passed to a process: distances are worked out inside the shell. | `fetch.sh`, `notify.sh` (`umask 077`, `mktemp`) | "downloads into place, private under umask 022"; "records are private under umask 022" |
| **A second monitor's bar**, or a shell restart mid-download | One download at a time per file, under a lock. Downloads go to a temporary file, then are renamed into place. Leftover temporary files are removed. | `fetch.sh` | "a second bar finds the download already running"; "temporary files from a killed download are removed later" |
| **Running anything** | Commands are passed as argument lists, never through a shell string. The only commands run are this plugin's two scripts, `omarchy-bar`, `omarchy-launch-browser`, `find` (cleanup, with trail-ID name patterns) and `curl`. | `Panel.qml` | — |

## Network

- `https://dfwmtbtrailhub.com/api/v1/trails`, `/api/v1/status-changes`, and `/api/v1/trails/<id>` for each
  favorite: when the cached copy is over 15 minutes old.
- `https://geo.omarchy.org/`: only when no Weather location is set, at most once a day.

## Site terms

The site's API terms (dfwmtbtrailhub.com/developers) ask for three things, and the plugin follows each:
- **Credit:** "DFW MTB Trail Hub" with a link, in the panel and the README, plus Open-Meteo for the weather.
- **Report age:** a status always comes with when it was reported, in the tiles, the rows, the tooltip and the
  nearest-trail bar label.
- **Trailhead overrides:** a closure posted at the trailhead overrides the site, which the panel's footer says.
