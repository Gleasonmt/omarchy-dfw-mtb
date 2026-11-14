.pragma library

// Pure logic for the DFW MTB Trail Hub widget: parsing the site's public API,
// measuring distance, choosing what the bar says, and which status changes
// deserve a notification. No QML here, so tests/model.test.mjs can run it
// under Node.

var KM_PER_MILE = 1.609344
var SITE = "https://dfwmtbtrailhub.com"

// Every string from the network is cut to a length the panel can show, so a
// huge field can't stall the shell laying it out.
var MAX_TEXT = 200
var MAX_SHORT = 80
var MAX_TRAILS = 500
var MAX_CHANGES = 200

var STATUSES = ["open", "caution", "closed"]
var CONDITIONS = ["epic", "good", "fair", "poor", "closed", "unknown"]
var LEVELS = ["Beginner", "Intermediate", "Advanced", "Expert"]

// Cut at `max` UTF-16 units, never between the halves of an emoji (a lone
// surrogate would draw as a box).
function text(value, max) {
  var s = String(value === undefined || value === null ? "" : value)
  if (s.length > max) {
    var end = max
    var c = s.charCodeAt(end - 1)
    if (c >= 0xd800 && c <= 0xdbff) end--
    s = s.slice(0, end)
  }
  return s.trim()
}

function coordinate(value, limit) {
  var n = parseFloat(value)
  return isNaN(n) || Math.abs(n) > limit ? null : n
}

function status(value) {
  return STATUSES.indexOf(value) >= 0 ? value : ""
}

function time(value) {
  var ms = Date.parse(text(value, MAX_SHORT))
  return isNaN(ms) ? null : ms
}

// Trail slugs are the site's own ("northshore-trail"); anything else is
// dropped, so a slug is always safe to store and compare.
var SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/
function slug(value) {
  return typeof value === "string" && SLUG.test(value) ? value : ""
}

// Links only ever go to the Trail Hub itself.
function siteUrl(value) {
  var url = String(value || "")
  return url.length <= 2048 && url.indexOf(SITE + "/") === 0 && !/[\s"'<>\\]/.test(url) ? url : ""
}

// /api/v1/trails. A trail without a slug, a name or a status is dropped,
// and a changed shape gives an empty list rather than an error.
function parseTrails(raw) {
  var data
  try {
    data = JSON.parse(String(raw || ""))
  } catch (e) {
    return { ok: false, generatedAt: null, trails: [] }
  }
  var list = data && Array.isArray(data.trails) ? data.trails : null
  if (!list) return { ok: false, generatedAt: null, trails: [] }
  var trails = []
  for (var i = 0; i < list.length && trails.length < MAX_TRAILS; i++) {
    var t = list[i]
    if (!t || typeof t !== "object") continue
    var s = t.status && typeof t.status === "object" ? t.status : {}
    var id = slug(t.slug)
    var name = text(t.name, MAX_TEXT)
    var shown = status(s.shown) || status(s.reported)
    if (!id || !name || !shown) continue
    var c = t.condition && typeof t.condition === "object" ? t.condition : {}
    var reopen = t.reopenEstimate && typeof t.reopenEstimate === "object" ? t.reopenEstimate : {}
    var inference = s.inference && typeof s.inference === "object" ? s.inference : null
    var lat = coordinate(t.latitude, 90)
    var lon = coordinate(t.longitude, 180)
    var d = t.difficulty && typeof t.difficulty === "object" ? t.difficulty : {}
    var org = t.organization && typeof t.organization === "object" ? t.organization : {}
    trails.push({
      slug: id,
      name: name,
      url: siteUrl(t.url) || SITE + "/trails/" + id,
      city: text(t.city, MAX_SHORT),
      shown: shown,
      reported: status(s.reported) || shown,
      reportedAt: time(s.reportedAt),
      unconfirmed: !!inference,
      condition: text(c.label, MAX_SHORT),
      conditionCode: CONDITIONS.indexOf(c.code) >= 0 ? c.code : "unknown",
      trailFeel: text(c.trailFeel, MAX_SHORT),
      easiest: level(d.easiest) || level(d.rating),
      hardest: level(d.hardest) || level(d.rating),
      org: text(org.name, MAX_SHORT),
      reopen: text(reopen.label, MAX_SHORT),
      lat: lat === null || lon === null ? null : lat,
      lon: lat === null || lon === null ? null : lon
    })
  }
  return { ok: true, generatedAt: time(data.generatedAt), trails: trails }
}

function level(value) {
  return LEVELS.indexOf(value) >= 0 ? value : ""
}

// /api/v1/trails/<slug>, for a favorite's tile: today's hour-by-hour dirt
// ({hour, condition, forecast}) and the day in words. null if unusable.
function parseDetail(raw) {
  var data
  try {
    data = JSON.parse(String(raw || ""))
  } catch (e) {
    return null
  }
  var t = data && typeof data === "object" ? (data.trail && typeof data.trail === "object" ? data.trail : data) : null
  if (!t || !slug(t.slug)) return null
  var list = Array.isArray(t.hourlyToday) ? t.hourlyToday : []
  var hourly = []
  for (var i = 0; i < list.length && hourly.length < 24; i++) {
    var h = list[i]
    if (!h || typeof h !== "object") continue
    var hour = Number(h.hour)
    if (!(hour >= 0 && hour <= 23 && Math.floor(hour) === hour)) continue
    hourly.push({ hour: hour, condition: CONDITIONS.indexOf(h.condition) >= 0 ? h.condition : "unknown", forecast: h.forecast === true })
  }
  var c = t.condition && typeof t.condition === "object" ? t.condition : {}
  return { slug: t.slug, hourly: hourly, trailFeel: text(c.trailFeel, MAX_SHORT) }
}

// DFW MTB Trail Hub's condition colors (its site.css), so a trail looks the
// same here as on the site: purple epic, green good, amber fair, red poor or
// closed. The dark set is for its tiles, which keep the site's dark card; the
// light set for rows on a light Omarchy theme, where the bright greens would
// wash out.
var TONES_DARK = { epic: "#a855f7", good: "#22ee88", fair: "#ffbb33", poor: "#ff4466", closed: "#ff4466", unknown: "#9aa3b5" }
var TONES_LIGHT = { epic: "#9333ea", good: "#16a34a", fair: "#d97706", poor: "#e11d48", closed: "#e11d48", unknown: "#555e72" }

function tone(code, light) {
  var set = light ? TONES_LIGHT : TONES_DARK
  return set[code] || set.unknown
}

// A trail's status as a condition color: open good, caution fair, closed.
function statusTone(shown, light) {
  return tone(shown === "open" ? "good" : shown === "caution" ? "fair" : "closed", light)
}

// "6a", "12p", "5p"
function hourLabel(hour) {
  return (hour % 12 === 0 ? 12 : hour % 12) + (hour < 12 ? "a" : "p")
}

// The site's difficulty symbols: ● beginner, ■ intermediate, ◆ advanced,
// ◆◆ expert. "Beginner–Advanced" when a trail spans levels.
function levelGlyph(value) {
  return value === "Beginner" ? "\u25cf" : value === "Intermediate" ? "\u25a0" : value === "Advanced" ? "\u25c6" : value === "Expert" ? "\u25c6\u25c6" : ""
}

function difficultyLabel(t) {
  if (!t.easiest) return ""
  return t.easiest === t.hardest || !t.hardest ? t.easiest : t.easiest + "\u2013" + t.hardest
}

// "40m ago", "5h ago", "2d ago": a report's age, short, for the bar.
function shortAge(ms, now) {
  if (ms === null || ms === undefined) return "date unknown"
  var minutes = Math.max(0, Math.floor((now - ms) / 60000))
  if (minutes < 2) return "just now"
  if (minutes < 60) return minutes + "m ago"
  var hours = Math.floor(minutes / 60)
  return hours < 24 ? hours + "h ago" : Math.floor(hours / 24) + "d ago"
}

// The footer's "report 27d ago", as the site writes it.
function reportAge(ms, now) {
  if (ms === null || ms === undefined) return "report date unknown"
  var minutes = Math.max(0, Math.floor((now - ms) / 60000))
  if (minutes < 60) return minutes < 2 ? "reported just now" : "report " + minutes + "m ago"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return "report " + hours + "h ago"
  return "report " + Math.floor(hours / 24) + "d ago"
}

// /api/v1/status-changes: trail changes only (skills parks aren't listed).
// null when the list can't be read at all, so the panel never takes an
// unreadable file for the first read (and then announces every old change).
function parseChanges(raw) {
  var data
  try {
    data = JSON.parse(String(raw || ""))
  } catch (e) {
    return null
  }
  if (!data || !Array.isArray(data.statusChanges)) return null
  var list = data.statusChanges
  var out = []
  var trailEntries = 0
  for (var i = 0; i < list.length && out.length < MAX_CHANGES; i++) {
    var c = list[i]
    if (!c || typeof c !== "object" || c.type !== "trail") continue
    trailEntries++
    var id = text(c.id, MAX_SHORT)
    var at = time(c.at)
    var s = slug(c.slug)
    var now = status(c.status)
    if (!id || at === null || !s || !now) continue
    out.push({
      id: id, at: at, slug: s,
      name: text(c.name, MAX_TEXT) || s,
      url: siteUrl(c.url) || SITE + "/trails/" + s,
      status: now,
      previous: status(c.previousStatus)
    })
  }
  // Trail entries but none usable is as unreadable as broken JSON; a list of
  // skills parks only is just a list with no trail changes
  if (trailEntries > 0 && out.length === 0) return null
  out.sort(function(a, b) { return b.at - a.at })
  return out
}

// Weather location (weather.json) or geo.omarchy.org: {name, latitude,
// longitude}. A name alone gives a location with no coordinates.
function parseLocation(raw) {
  var data
  try {
    data = JSON.parse(String(raw || ""))
  } catch (e) {
    return null
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  var name = text(data.name, MAX_SHORT)
  var lat = coordinate(data.latitude, 90)
  var lon = coordinate(data.longitude, 180)
  var located = lat !== null && lon !== null
  if (!located && !name) return null
  return { name: name, lat: located ? lat : null, lon: located ? lon : null }
}

function hasCoordinates(location) {
  return !!location && location.lat !== null && location.lon !== null
}

// Favorites live on the widget's entry in shell.json as a list of slugs.
// Text ("a,b") is accepted too, for a hand edit; anything else is ignored.
function parseFavorites(value) {
  var list = Array.isArray(value) ? value : (typeof value === "string" ? value.split(",") : [])
  var out = []
  for (var i = 0; i < list.length && out.length < 100; i++) {
    var s = slug(typeof list[i] === "string" ? list[i].trim() : list[i])
    if (s && out.indexOf(s) < 0) out.push(s)
  }
  return out
}

function toggleFavorite(favorites, id) {
  var list = parseFavorites(favorites)
  var i = list.indexOf(id)
  if (i >= 0) list.splice(i, 1)
  else if (slug(id)) list.push(id)
  return list
}

function distanceKm(lat1, lon1, lat2, lon2) {
  var r = 6371.0088
  var toRad = Math.PI / 180
  var dLat = (lat2 - lat1) * toRad
  var dLon = (lon2 - lon1) * toRad
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)))
}

// The trails with their distance from origin (null without one) and whether
// each is a favorite, sorted: "nearest" (by name without a location),
// "name", or "status" (open, then caution, then closed).
function arrange(trails, origin, unit, favorites, sort) {
  var favs = parseFavorites(favorites)
  var located = hasCoordinates(origin)
  var out = []
  for (var i = 0; i < trails.length; i++) {
    var t = trails[i]
    var km = located && t.lat !== null ? distanceKm(origin.lat, origin.lon, t.lat, t.lon) : null
    var copy = {}
    for (var k in t) copy[k] = t[k]
    copy.distance = km === null ? null : (unit === "km" ? km : km / KM_PER_MILE)
    copy.favorite = favs.indexOf(t.slug) >= 0
    out.push(copy)
  }
  var byName = function(a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0 }
  var byDistance = function(a, b) {
    if (a.distance === null || b.distance === null) return a.distance === null ? (b.distance === null ? byName(a, b) : 1) : -1
    return a.distance - b.distance || byName(a, b)
  }
  var byStatus = function(a, b) {
    return STATUSES.indexOf(a.shown) - STATUSES.indexOf(b.shown) || (located ? byDistance(a, b) : byName(a, b))
  }
  out.sort(sort === "name" ? byName : sort === "status" ? byStatus : (located ? byDistance : byName))
  return out
}

function countOpen(trails) {
  var n = 0
  for (var i = 0; i < trails.length; i++) if (trails[i].shown === "open") n++
  return n
}

function favoritesOf(trails) {
  return trails.filter(function(t) { return t.favorite })
}

function nearest(trails) {
  var best = null
  for (var i = 0; i < trails.length; i++) {
    var t = trails[i]
    if (t.distance !== null && (best === null || t.distance < best.distance)) best = t
  }
  return best
}

function statusWord(s) {
  return s === "open" ? "Open" : s === "caution" ? "Caution" : s === "closed" ? "Closed" : ""
}

function shortName(name, max) {
  var n = String(name)
  return n.length <= max ? n : n.slice(0, max - 1).trim() + "…"
}

// The site asks that a status always comes with when it was reported, so
// "nearest" carries its age: "Arbor Hills · open · 2d ago".
// What the bar says, for mode "favorites" (falls back to the count with no
// favorites), "count", or "nearest" (falls back to the count without a
// location). Never a clock time.
function barLabel(mode, arranged, now) {
  if (!arranged.length) return ""
  if (mode === "nearest") {
    var n = nearest(arranged)
    if (n) return shortName(n.name, 18) + " · " + n.shown + " · " + shortAge(n.reportedAt, now)
  }
  if (mode === "favorites" || mode === "nearest") {
    var favs = favoritesOf(arranged)
    if (mode === "favorites" && favs.length) return countOpen(favs) + "/" + favs.length + " open"
  }
  return countOpen(arranged) + " open"
}

// True when the bar should draw attention: a favorite (or, in nearest mode,
// the nearest trail) isn't open.
function barAlert(mode, arranged) {
  if (mode === "nearest") {
    var n = nearest(arranged)
    if (n) return n.shown !== "open"
  }
  if (mode !== "favorites") return false
  var favs = favoritesOf(arranged)
  for (var i = 0; i < favs.length; i++) if (favs[i].shown !== "open") return true
  return false
}

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// When something was reported, as the site asks it always be shown: "just
// now", "25 min ago", "3 hr ago", "2 days ago", then the date.
function ago(ms, now) {
  if (ms === null || ms === undefined) return "date unknown"
  var minutes = Math.floor((now - ms) / 60000)
  if (minutes < 2) return "just now"
  if (minutes < 60) return minutes + " min ago"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + " hr ago"
  var days = Math.floor(hours / 24)
  if (days < 14) return days + (days === 1 ? " day ago" : " days ago")
  var d = new Date(ms)
  return MONTHS[d.getMonth()] + " " + d.getDate()
}

function formatDistance(distance, unit) {
  if (distance === null || distance === undefined) return ""
  var n = distance < 10 ? Math.round(distance * 10) / 10 : Math.round(distance)
  return n + " " + (unit === "km" ? "km" : "mi")
}

// The line under a trail's name: the distance (first, so a narrow panel
// cuts the end, not it), its status with when it was reported, the dirt, and
// a reopening estimate when closed.
// "4 mi · Open · Hard-Packed · reported 2 days ago"
function caption(t, unit, now) {
  var parts = []
  var d = formatDistance(t.distance, unit)
  if (d) parts.push(d)
  parts.push(statusWord(t.shown) + (t.unconfirmed ? " (unconfirmed)" : ""))
  if (t.condition && t.condition !== statusWord(t.shown)) parts.push(t.condition)
  if (t.shown === "closed" && t.reopen) parts.push("reopens " + t.reopen)
  parts.push("reported " + ago(t.reportedAt, now))
  return parts.join(" · ")
}

// A status change dated this far ahead of the clock isn't believed: one from
// the future would never age out.
var FUTURE_SLACK_MS = 10 * 60 * 1000

// At most this many notifications per update; the rest are one summary, so a
// feed full of changes (or a compromised one) can't flood the desktop.
var MAX_ALERTS = 3

// Status changes worth a notification: ones not in `seen` (the changes listed
// at the first read, or when alerts or favorites last changed: see
// alertStep), not dated in the future, for any trail with alerts "all" or for
// favorites with "favorites". Oldest first.
function alertsDue(changes, mode, favorites, seen, now) {
  if (mode !== "all" && mode !== "favorites") return []
  var favs = parseFavorites(favorites)
  var out = []
  for (var i = 0; i < changes.length; i++) {
    var c = changes[i]
    if (seen && seen.ids[c.id] !== undefined) continue
    if (c.at > now + FUTURE_SLACK_MS) continue
    if (mode === "favorites" && favs.indexOf(c.slug) < 0) continue
    out.push(c)
  }
  out.sort(function(a, b) { return a.at - b.at })
  return out
}

// The changes listed now, as a `seen` set for alertsDue. The ids come from
// the feed, so the set has no prototype: an id like "__proto__" made a plain
// {} throw (alerts stopped on every bar), and "constructor" or "toString"
// read as already seen.
//
// { ids, n }: each id with the order it was first seen in, so the set only
// ever grows, and past MAX_SEEN forgets its oldest ids, never the ones a
// short or empty list happened to leave out.
var MAX_SEEN = 1000

function seenSet(changes) {
  return mergeSeen(null, changes)
}

// `seen` with the changes listed now added (a new set; `seen` is unchanged).
function mergeSeen(seen, changes) {
  var ids = Object.create(null)
  var n = 0
  if (seen) {
    for (var id in seen.ids) ids[id] = seen.ids[id]
    n = seen.n
  }
  for (var i = 0; i < changes.length; i++) {
    if (ids[changes[i].id] === undefined) ids[changes[i].id] = ++n
  }
  var keys = Object.keys(ids)
  if (keys.length > MAX_SEEN) {
    keys.sort(function(a, b) { return ids[a] - ids[b] })
    for (var k = 0; k < keys.length - MAX_SEEN; k++) delete ids[keys[k]]
  }
  return { ids: ids, n: n }
}

// One alerts update, as the panel runs it each time the change list is read:
// { seen, each, more }. The first read (`seen` null) only records what's
// listed, so installing the widget never announces old changes; a read of an
// empty list counts as one. After that, the changes not seen yet are due:
// at most MAX_ALERTS one by one (`each`), and `more` in one summary. Changes
// posted while the shell was off are in a later download, so they're
// announced then, with their date (alertText).
function alertStep(seen, changes, mode, favorites, now) {
  // No usable list (parseChanges' null) changes nothing
  if (!changes) return { seen: seen, each: [], more: 0 }
  if (seen === null) return { seen: seenSet(changes), each: [], more: 0 }
  var batch = alertBatch(alertsDue(changes, mode, favorites, seen, now))
  return { seen: mergeSeen(seen, changes), each: batch.each, more: batch.more }
}

// When favorites or the alerts setting change, everything listed now counts
// as seen: starring a trail or switching alerts on never replays its past.
function alertsReset(seen, changes) {
  return seen === null || !changes ? seen : mergeSeen(seen, changes)
}

// alertsDue's list split into the ones notified one by one and how many more
// go into a single summary.
function alertBatch(due) {
  return { each: due.slice(0, MAX_ALERTS), more: Math.max(0, due.length - MAX_ALERTS) }
}

function summaryText(more) {
  return {
    headline: more + " more trail " + (more === 1 ? "change" : "changes"),
    body: "See them on DFW MTB Trail Hub"
  }
}

// A notification body is markup to Omarchy's notification service, which
// decodes entities before drawing, so the characters markup is made of are
// swapped for look-alikes: nothing in feed text can be a tag or an entity.
function plainText(value) {
  return String(value).replace(/&/g, "＆").replace(/</g, "‹").replace(/>/g, "›")
}

function clock(ms) {
  var d = new Date(ms)
  var h = d.getHours()
  var m = d.getMinutes()
  return (h % 12 === 0 ? 12 : h % 12) + (m ? ":" + (m < 10 ? "0" : "") + m : "") + (h < 12 ? " AM" : " PM")
}

// When a change was reported, for its notification: "12:55 PM" today,
// "yesterday 12:55 PM", else "Nov 12, 12:55 PM", so one announced after the
// laptop was off doesn't read as today's.
function reportedWhen(ms, now) {
  var day = function(t) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
  var days = Math.round((day(now) - day(ms)) / 86400000)
  if (days === 0) return clock(ms)
  if (days === 1) return "yesterday " + clock(ms)
  var d = new Date(ms)
  return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + clock(ms)
}

// Headline and body for a status change. Public trail data only.
function alertText(change, now) {
  var word = change.status === "open" ? "open" : change.status === "closed" ? "closed" : "on caution"
  return {
    headline: plainText(change.name) + " is " + word,
    body: plainText((change.previous ? "Was " + change.previous + " · " : "") + "reported " + reportedWhen(change.at, now)) + "\nDFW MTB Trail Hub"
  }
}

// The value after `current` in `options`, wrapping around.
function cycle(current, options, direction) {
  var i = options.indexOf(current)
  var n = options.length
  return options[((i < 0 ? 0 : i + (direction < 0 ? -1 : 1)) % n + n) % n]
}

function barModeLabel(mode) {
  return mode === "count" ? "how many trails are open" : mode === "nearest" ? "your nearest trail" : "your favorites"
}

function alertsLabel(mode) {
  return mode === "all" ? "any trail" : mode === "off" ? "off" : "favorites"
}

function sortLabel(mode) {
  return mode === "name" ? "name" : mode === "status" ? "open first" : "nearest first"
}

function fileUrl(path) {
  return "file://" + String(path).split("/").map(encodeURIComponent).join("/")
}
