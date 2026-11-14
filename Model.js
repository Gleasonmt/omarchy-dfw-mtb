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

function text(value, max) {
  return String(value === undefined || value === null ? "" : value).slice(0, max).trim()
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
      reopen: text(reopen.label, MAX_SHORT),
      lat: lat === null || lon === null ? null : lat,
      lon: lat === null || lon === null ? null : lon
    })
  }
  return { ok: true, generatedAt: time(data.generatedAt), trails: trails }
}

// /api/v1/status-changes: trail changes only (skills parks aren't listed).
function parseChanges(raw) {
  var data
  try {
    data = JSON.parse(String(raw || ""))
  } catch (e) {
    return []
  }
  var list = data && Array.isArray(data.statusChanges) ? data.statusChanges : []
  var out = []
  for (var i = 0; i < list.length && out.length < MAX_CHANGES; i++) {
    var c = list[i]
    if (!c || typeof c !== "object" || c.type !== "trail") continue
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

// What the bar says, for mode "favorites" (falls back to the count with no
// favorites), "count", or "nearest" (falls back to the count without a
// location). Never a clock time.
function barLabel(mode, arranged) {
  if (!arranged.length) return ""
  if (mode === "nearest") {
    var n = nearest(arranged)
    if (n) return shortName(n.name, 18) + " · " + n.shown
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

// Status changes worth a notification: newer than `since` (so installing the
// widget, or waking the laptop, doesn't replay a backlog), for any trail with
// alerts "all", or for favorites with "favorites". Oldest first.
function alertsDue(changes, mode, favorites, since) {
  if (mode !== "all" && mode !== "favorites") return []
  var favs = parseFavorites(favorites)
  var out = []
  for (var i = 0; i < changes.length; i++) {
    var c = changes[i]
    if (c.at <= since) continue
    if (mode === "favorites" && favs.indexOf(c.slug) < 0) continue
    out.push(c)
  }
  out.sort(function(a, b) { return a.at - b.at })
  return out
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

// Headline and body for a status change. Public trail data only.
function alertText(change) {
  var word = change.status === "open" ? "open" : change.status === "closed" ? "closed" : "on caution"
  return {
    headline: plainText(change.name) + " is " + word,
    body: plainText((change.previous ? "Was " + change.previous + " · " : "") + "reported " + clock(change.at)) + "\nDFW MTB Trail Hub"
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
