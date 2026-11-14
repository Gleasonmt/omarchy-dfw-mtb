// Runs Model.js under Node: node --test tests/
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import vm from "node:vm"

process.env.TZ = "America/Chicago"

const source = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
  .replace(/^\.pragma library\s*$/m, "")
const M = {}
vm.runInNewContext(source, M)

// Objects made inside the vm context have their own prototypes; compare plain copies.
const plain = x => JSON.parse(JSON.stringify(x))

// Trimmed from the real /api/v1/trails.
const trail = (slug, name, shown, extra = {}) => ({
  slug, name, url: `https://dfwmtbtrailhub.com/trails/${slug}`, city: "Plano",
  latitude: 33, longitude: -96.8,
  status: { reported: shown, reportedAt: "2026-11-12T14:00:00.000Z", shown, inference: null },
  condition: { code: "good", label: "Hard-Packed", trailFeel: "Good all day" },
  reopenEstimate: null, ...extra,
})
const arbor = trail("arbor-hills", "Arbor Hills", "open", { latitude: 33.04791, longitude: -96.84754 })
const northshore = trail("northshore-trail", "Northshore Trail", "open", { latitude: 32.98, longitude: -97.1 })
const erwin = trail("erwin-park", "Erwin Park", "closed", { latitude: 33.25, longitude: -96.67,
  condition: { code: "closed", label: "Closed" }, reopenEstimate: { label: "Sat, Nov 15 morning", expectedAt: null, confidence: "low", factors: [] } })
const goat = trail("goat-island-preserve", "Goat Island Preserve", "caution", { latitude: 32.6, longitude: -96.4,
  status: { reported: "closed", reportedAt: "2026-10-04T17:00:00.000Z", shown: "caution", inference: { kind: "unconfirmed" } },
  condition: { code: "unknown", label: "Status Unconfirmed" } })
const feed = (trails, extra = {}) => JSON.stringify({ apiVersion: "1", generatedAt: "2026-11-14T15:00:00.000Z", trails, ...extra })
const carrollton = { name: "Carrollton", lat: 32.95373, lon: -96.89028 }
const now = Date.parse("2026-11-14T15:00:00Z")
const all = () => M.parseTrails(feed([arbor, northshore, erwin, goat])).trails

test("parseTrails keeps the fields the panel needs", () => {
  const parsed = M.parseTrails(feed([arbor, erwin, goat]))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.generatedAt, now)
  assert.deepEqual(plain(parsed.trails[1]), {
    slug: "erwin-park", name: "Erwin Park", url: "https://dfwmtbtrailhub.com/trails/erwin-park", city: "Plano",
    shown: "closed", reported: "closed", reportedAt: Date.parse("2026-11-12T14:00:00.000Z"), unconfirmed: false,
    condition: "Closed", conditionCode: "closed", trailFeel: "", easiest: "", hardest: "", org: "",
    reopen: "Sat, Nov 15 morning", lat: 33.25, lon: -96.67,
  })
  assert.equal(parsed.trails[2].shown, "caution")
  assert.equal(parsed.trails[2].reported, "closed")
  assert.equal(parsed.trails[2].unconfirmed, true)
})

test("parseTrails drops what it can't trust, and survives a changed shape", () => {
  const bad = [
    { ...arbor, slug: "../etc" }, { ...arbor, slug: "Arbor Hills" }, { ...arbor, slug: "__proto__" }, { ...arbor, slug: 7 },
    { ...arbor, name: "" }, { ...arbor, status: { shown: "flooded" } }, { ...arbor, status: null }, null, "x", 42,
  ]
  assert.deepEqual(plain(M.parseTrails(feed(bad)).trails), [])
  for (const raw of ["", "not json", "null", "[]", '{"trails":{}}', '{"trails":"x"}']) {
    assert.deepEqual(plain(M.parseTrails(raw)), { ok: false, generatedAt: null, trails: [] }, raw)
  }
  const parsed = M.parseTrails(feed([{ ...arbor, url: "javascript:alert(1)" }, { ...northshore, url: "https://evil.example/x" },
    { ...erwin, url: "https://dfwmtbtrailhub.com.evil.example/x" }, { ...goat, url: 'https://dfwmtbtrailhub.com/a"b' }]))
  assert.deepEqual(plain(parsed.trails.map(t => t.url)), [
    "https://dfwmtbtrailhub.com/trails/arbor-hills", "https://dfwmtbtrailhub.com/trails/northshore-trail",
    "https://dfwmtbtrailhub.com/trails/erwin-park", "https://dfwmtbtrailhub.com/trails/goat-island-preserve",
  ], "links only ever go to the Trail Hub")
})

test("parseTrails caps every field and the list itself", () => {
  const huge = "x".repeat(100000)
  const t = M.parseTrails(feed([{ ...arbor, name: huge, city: huge, condition: { label: huge }, reopenEstimate: { label: huge } }])).trails[0]
  assert.equal(t.name.length, 200)
  assert.equal(t.city.length, 80)
  assert.equal(t.condition.length, 80)
  assert.equal(t.reopen.length, 80)
  const many = Array.from({ length: 600 }, (_, i) => ({ ...arbor, slug: "t" + i }))
  assert.equal(M.parseTrails(feed(many)).trails.length, 500)
  const html = M.parseTrails(feed([{ ...arbor, name: "<img src=x onerror=alert(1)>" }])).trails[0]
  assert.equal(html.name, "<img src=x onerror=alert(1)>", "kept as text; the panel shows it as plain text")
})

test("parseChanges keeps trail changes, newest first", () => {
  const raw = JSON.stringify({ statusChanges: [
    { id: "a", at: "2026-11-10T19:07:31.000Z", type: "trail", slug: "gateway-park", name: "Gateway Park",
      url: "https://dfwmtbtrailhub.com/trails/gateway-park", status: "open", previousStatus: "closed" },
    { id: "b", at: "2026-11-11T13:59:26.000Z", type: "trail", slug: "cedar-hill-state-park", name: "Cedar Hill State Park",
      url: "https://evil.example/", status: "open", previousStatus: "closed" },
    { id: "c", at: "2026-11-11T14:00:00.000Z", type: "skills_park", slug: "x", name: "X", status: "open" },
    { id: "d", at: "soon", type: "trail", slug: "y", status: "open" },
    { id: "e", at: "2026-11-11T14:00:00.000Z", type: "trail", slug: "Bad Slug", status: "open" },
    { id: "f", at: "2026-11-11T14:00:00.000Z", type: "trail", slug: "z", status: "muddy" },
  ] })
  const changes = M.parseChanges(raw)
  assert.deepEqual(plain(changes.map(c => c.id)), ["b", "a"])
  assert.equal(changes[0].url, "https://dfwmtbtrailhub.com/trails/cedar-hill-state-park", "a foreign link is replaced")
  assert.equal(changes[1].previous, "closed")
  for (const raw of ["nope", "", "null", "[]", '{"statusChanges":{}}']) assert.equal(M.parseChanges(raw), null, raw)
  assert.deepEqual(plain(M.parseChanges('{"statusChanges":[]}')), [], "an empty list is a list")
})

test("favorites: parsed leniently, toggled, never anything but slugs", () => {
  assert.deepEqual(plain(M.parseFavorites(["arbor-hills", "arbor-hills", "Bad", 3, null, "erwin-park"])), ["arbor-hills", "erwin-park"])
  assert.deepEqual(plain(M.parseFavorites("arbor-hills, erwin-park")), ["arbor-hills", "erwin-park"], "a hand-edited string works")
  assert.deepEqual(plain(M.parseFavorites({ a: 1 })), [])
  assert.deepEqual(plain(M.toggleFavorite(["arbor-hills"], "erwin-park")), ["arbor-hills", "erwin-park"])
  assert.deepEqual(plain(M.toggleFavorite(["arbor-hills", "erwin-park"], "arbor-hills")), ["erwin-park"])
  assert.deepEqual(plain(M.toggleFavorite([], "../x")), [])
  assert.equal(M.parseFavorites(Array.from({ length: 300 }, (_, i) => "t" + i)).length, 100)
})

test("arrange: nearest first from your location, by name without one, or open first", () => {
  const near = M.arrange(all(), carrollton, "mi", ["erwin-park"], "nearest")
  assert.deepEqual(plain(near.map(t => t.slug)), ["arbor-hills", "northshore-trail", "erwin-park", "goat-island-preserve"])
  assert.ok(Math.abs(near[0].distance - 6.96) < 0.05, "Arbor Hills is about 7 miles from Carrollton")
  assert.equal(near.find(t => t.slug === "erwin-park").favorite, true)
  assert.deepEqual(plain(M.arrange(all(), null, "mi", [], "nearest").map(t => t.slug)),
    ["arbor-hills", "erwin-park", "goat-island-preserve", "northshore-trail"], "no location: by name")
  assert.deepEqual(plain(M.arrange(all(), carrollton, "mi", [], "status").map(t => t.shown)), ["open", "open", "caution", "closed"])
  assert.deepEqual(plain(M.arrange(all(), carrollton, "mi", [], "name").map(t => t.slug)),
    ["arbor-hills", "erwin-park", "goat-island-preserve", "northshore-trail"])
  const km = M.arrange(all(), carrollton, "km", [], "nearest")
  assert.ok(Math.abs(km.find(t => t.slug === "arbor-hills").distance - 11.21) < 0.05)
})

test("the bar: favorites, the overall count, or the nearest trail, with fallbacks", () => {
  const favs = M.arrange(all(), carrollton, "mi", ["arbor-hills", "erwin-park"], "nearest")
  assert.equal(M.barLabel("favorites", favs, now), "1/2 open")
  assert.equal(M.barAlert("favorites", favs), true, "a favorite is closed")
  assert.equal(M.barLabel("count", favs, now), "2 open")
  assert.equal(M.barAlert("count", favs), false)
  assert.equal(M.barLabel("nearest", favs, now), "Arbor Hills · open · 2d ago", "the site asks for the report's age with a status")
  assert.equal(M.barAlert("nearest", favs), false)
  const none = M.arrange(all(), carrollton, "mi", [], "nearest")
  assert.equal(M.barLabel("favorites", none, now), "2 open", "no favorites yet: the overall count")
  assert.equal(M.barAlert("favorites", none), false)
  const lost = M.arrange(all(), null, "mi", [], "name")
  assert.equal(M.barLabel("nearest", lost, now), "2 open", "no location: the overall count")
  assert.equal(M.barLabel("favorites", [], now), "", "nothing loaded yet")
  const long = M.arrange(M.parseTrails(feed([trail("long", "Waterloo Lake Regional Park", "open")])).trails, carrollton, "mi", [], "nearest")
  assert.equal(M.barLabel("nearest", long, now), "Waterloo Lake Reg… · open · 2d ago")
})

test("when a status was reported is always shown", () => {
  assert.equal(M.ago(now - 30000, now), "just now")
  assert.equal(M.ago(now - 25 * 60000, now), "25 min ago")
  assert.equal(M.ago(now - 3 * 3600000, now), "3 hr ago")
  assert.equal(M.ago(now - 86400000, now), "1 day ago")
  assert.equal(M.ago(now - 9 * 86400000, now), "9 days ago")
  assert.equal(M.ago(Date.parse("2026-10-04T17:00:00Z"), now), "Oct 4")
  assert.equal(M.ago(null, now), "date unknown")
  const t = M.arrange(all(), carrollton, "mi", [], "nearest")
  assert.equal(M.caption(t.find(x => x.slug === "arbor-hills"), "mi", now), "7 mi · Open · Hard-Packed · reported 2 days ago")
  assert.equal(M.caption(t.find(x => x.slug === "erwin-park"), "mi", now), "24 mi · Closed · reopens Sat, Nov 15 morning · reported 2 days ago")
  assert.equal(M.caption(t.find(x => x.slug === "goat-island-preserve"), "mi", now), "38 mi · Caution (unconfirmed) · Status Unconfirmed · reported Oct 4")
  assert.equal(M.caption(M.arrange(all(), null, "mi", [], "name")[0], "mi", now), "Open · Hard-Packed · reported 2 days ago", "no distance without a location")
})

const change = (id, slug, at, status = "closed", previous = "open") =>
  ({ id, slug, name: slug, url: `https://dfwmtbtrailhub.com/trails/${slug}`, at: Date.parse(at), status, previous })

test("alerts: only changes not seen yet, for favorites or any trail, oldest first", () => {
  const old = [change("3", "arbor-hills", "2026-11-13T10:00:00Z")]
  const seen = M.seenSet(old)
  const changes = [change("1", "arbor-hills", "2026-11-14T14:00:00Z"), change("2", "erwin-park", "2026-11-14T13:00:00Z"), ...old]
  assert.deepEqual(plain(M.alertsDue(changes, "favorites", ["arbor-hills"], seen, now).map(c => c.id)), ["1"])
  assert.deepEqual(plain(M.alertsDue(changes, "all", [], seen, now).map(c => c.id)), ["2", "1"])
  assert.deepEqual(plain(M.alertsDue(changes, "off", ["arbor-hills"], seen, now)), [])
  assert.deepEqual(plain(M.alertsDue(changes, "favorites", [], seen, now)), [], "no favorites: nothing")
  assert.deepEqual(plain(M.alertsDue(changes, "bogus", ["arbor-hills"], seen, now)), [])
  // Starring a trail marks its past changes seen: nothing replays (the panel calls seenSet again)
  assert.deepEqual(plain(M.alertsDue(changes, "all", [], M.seenSet(changes), now)), [])
})

test("alerts: a change dated in the future isn't believed, and a flood is three alerts and one summary", () => {
  const ahead = change("f", "arbor-hills", "2026-11-15T15:00:00Z")
  const soon = change("s", "arbor-hills", new Date(now + 5 * 60000).toISOString())
  assert.deepEqual(plain(M.alertsDue([ahead, soon], "all", [], M.seenSet([]), now).map(c => c.id)), ["s"], "minutes of clock skew are fine")
  const flood = Array.from({ length: 200 }, (_, i) => change("c" + i, "arbor-hills", new Date(now - i * 60000).toISOString()))
  const batch = M.alertBatch(M.alertsDue(flood, "all", [], M.seenSet([]), now))
  assert.equal(batch.each.length, 3)
  assert.deepEqual(plain(batch.each.map(c => c.id)), ["c199", "c198", "c197"], "oldest first")
  assert.equal(batch.more, 197)
  assert.deepEqual(plain(M.summaryText(197)), { headline: "197 more trail changes", body: "See them on DFW MTB Trail Hub" })
  assert.equal(M.summaryText(1).headline, "1 more trail change")
  assert.deepEqual(plain(M.alertBatch([])), { each: [], more: 0 })
})

test("text cuts never split an emoji", () => {
  const bike = "\u{1F6B5}"
  const name = "x".repeat(199) + bike
  const t = M.parseTrails(feed([{ ...arbor, name }])).trails[0]
  assert.equal(t.name, "x".repeat(199), "the half emoji is dropped, not kept as a lone surrogate")
  assert.doesNotMatch(t.name, /[\ud800-\udfff]/)
  assert.equal(M.parseTrails(feed([{ ...arbor, name: "x".repeat(198) + bike }])).trails[0].name.length, 200, "a whole one fits")
})

test("alert text: public trail data, and no markup can survive", () => {
  const c = { ...change("1", "x", "2026-11-14T19:30:00Z"), name: '<b>Tom & Jerry</b> &lt;i&gt;' }
  const t = M.alertText(c, now)
  assert.equal(t.headline, "‹b›Tom ＆ Jerry‹/b› ＆lt;i＆gt; is closed")
  assert.equal(t.body, "Was open · reported 1:30 PM\nDFW MTB Trail Hub")
  assert.doesNotMatch(t.headline + t.body, /[<>&]/)
  assert.equal(M.alertText({ ...c, name: "A", status: "caution", previous: "" }, now).headline, "A is on caution")
  assert.equal(M.alertText({ ...c, name: "A", status: "open", previous: "" }, now).body, "reported 1:30 PM\nDFW MTB Trail Hub")
})

// Measured, not modelled: run alert text through Omarchy's own notification
// markup (when Omarchy is installed; CI has no Omarchy, so it is skipped).
const markupDir = "/usr/share/omarchy/shell/plugins/notifications"
test("Omarchy's notification markup draws alert text as plain text", { skip: !existsSync(markupDir + "/Markup.js") }, () => {
  const load = name => readFileSync(`${markupDir}/${name}`, "utf8").replace(/^\.pragma library\s*$/m, "").replace(/^\.import .*$/mg, "")
  const ctx = { Security: {} }
  vm.runInNewContext(load("Security.js"), ctx.Security)
  vm.runInNewContext(load("Markup.js"), ctx)
  const t = M.alertText({ ...change("1", "x", "2026-11-14T19:30:00Z"),
    name: '<b>Bold</b> &lt;i&gt;x&lt;/i&gt; <a href="https://example.com/">Click</a> &amp;amp;' })
  for (const text of [t.headline, t.body]) {
    assert.doesNotMatch(ctx.render(text), /<(b|i|s|u|em|strong|a)\b/i, ctx.render(text))
  }
  assert.match(ctx.render("&lt;b&gt;x&lt;/b&gt;"), /<b>/, "the service does decode escaped markup")
})

test("settings rows cycle through their choices both ways", () => {
  assert.equal(M.cycle("favorites", ["favorites", "count", "nearest"], 1), "count")
  assert.equal(M.cycle("nearest", ["favorites", "count", "nearest"], 1), "favorites")
  assert.equal(M.cycle("favorites", ["favorites", "count", "nearest"], -1), "nearest")
  assert.equal(M.cycle("junk", ["favorites", "count", "nearest"], 1), "favorites")
})

test("file URLs encode every path segment", () => {
  assert.equal(M.fileUrl("/home/q#1%?/x"), "file:///home/q%231%25%3F/x")
})

test("tiles: the maintainer, difficulty and condition code come through", () => {
  const raw = feed([{ ...arbor, organization: { name: "DORBA", fullName: "Dallas Off-Road Bicycle Association" },
    difficulty: { rating: "Mixed", easiest: "Beginner", hardest: "Advanced" },
    condition: { code: "epic", label: "Hero Dirt", trailFeel: "Fair until 10 AM, then Good" } },
    { ...northshore, organization: "x".repeat(5000), difficulty: { rating: "Intermediate", easiest: null, hardest: null }, condition: { code: "lava" } },
    { ...erwin, difficulty: { rating: "<b>Hard</b>" } }])
  const [a, n, e] = M.parseTrails(raw).trails
  assert.equal(a.org, "DORBA")
  assert.equal(a.conditionCode, "epic")
  assert.equal(a.trailFeel, "Fair until 10 AM, then Good")
  assert.equal(M.difficultyLabel(a), "Beginner–Advanced")
  assert.equal(M.levelGlyph(a.easiest) + M.levelGlyph(a.hardest), "●◆")
  assert.equal(n.org, "", "an organization that isn't an object is ignored")
  assert.equal(n.conditionCode, "unknown")
  assert.equal(M.difficultyLabel(n), "Intermediate")
  assert.equal(M.difficultyLabel(e), "", "only the site's four levels")
})

test("parseDetail: today's hours, capped and checked", () => {
  const detail = M.parseDetail(JSON.stringify({ trail: { slug: "cameron-park", condition: { trailFeel: "Good until 5 PM, then Poor" },
    hourlyToday: [{ hour: 6, condition: "good", forecast: false }, { hour: 17, condition: "poor", forecast: true },
      { hour: 25, condition: "good" }, { hour: 7.5, condition: "good" }, { hour: "8", condition: "lava", forecast: "yes" }, null] } }))
  assert.deepEqual(plain(detail), { slug: "cameron-park", trailFeel: "Good until 5 PM, then Poor", hourly: [
    { hour: 6, condition: "good", forecast: false }, { hour: 17, condition: "poor", forecast: true },
    { hour: 8, condition: "unknown", forecast: false }] })
  assert.equal(M.parseDetail(JSON.stringify({ slug: "x", hourlyToday: Array.from({ length: 100 }, () => ({ hour: 6, condition: "good" })) })).hourly.length, 24)
  assert.equal(M.parseDetail('{"trail":{"slug":"../x"}}'), null)
  assert.equal(M.parseDetail("nope"), null)
  assert.equal(M.hourLabel(6) + M.hourLabel(12) + M.hourLabel(17) + M.hourLabel(0), "6a12p5p12a")
})

test("the site's colors, dark for tiles and light for light themes", () => {
  assert.equal(M.tone("epic", false), "#a855f7")
  assert.equal(M.tone("good", false), "#22ee88")
  assert.equal(M.tone("poor", true), "#e11d48")
  assert.equal(M.tone("lava", false), "#9aa3b5")
  assert.equal(M.statusTone("open", false), "#22ee88")
  assert.equal(M.statusTone("caution", false), "#ffbb33")
  assert.equal(M.statusTone("closed", true), "#e11d48")
})

test("report age reads like the site's tiles", () => {
  assert.equal(M.reportAge(now - 30000, now), "reported just now")
  assert.equal(M.reportAge(now - 40 * 60000, now), "report 40m ago")
  assert.equal(M.reportAge(now - 5 * 3600000, now), "report 5h ago")
  assert.equal(M.reportAge(now - 27 * 86400000, now), "report 27d ago")
  assert.equal(M.reportAge(null, now), "report date unknown")
})

test("the alerts' lifecycle: the first read only records, new changes are announced once, starring replays nothing", () => {
  const a = change("a", "arbor-hills", "2026-11-14T13:00:00Z")
  const b = change("b", "erwin-park", "2026-11-14T14:00:00Z")
  const c = change("c", "arbor-hills", "2026-11-14T14:30:00Z")
  // First read (install, shell start): nothing announced
  let step = M.alertStep(null, [a, b], "all", [], now)
  assert.deepEqual([step.each.length, step.more], [0, 0])
  // A later read with a new change: announced, then never again
  step = M.alertStep(step.seen, [c, a, b], "all", [], now)
  assert.deepEqual(plain(step.each.map(x => x.id)), ["c"])
  step = M.alertStep(step.seen, [c, a, b], "all", [], now)
  assert.equal(step.each.length, 0)
  // An empty first read is a read: the next list's changes are new
  const empty = M.alertStep(null, [], "all", [], now)
  assert.deepEqual(plain(M.alertStep(empty.seen, [a], "all", [], now).each.map(x => x.id)), ["a"])
  // Starring a trail (or switching alerts on) counts everything listed as seen
  const before = M.alertStep(null, [], "favorites", [], now).seen
  const starred = M.alertsReset(before, [a, c])
  assert.deepEqual(plain(M.alertStep(starred, [a, c], "favorites", ["arbor-hills"], now).each), [])
  assert.equal(M.alertsReset(null, [a]), null, "before the first read there's nothing to reset")
})

test("change ids from the feed can't break or hide alerts (__proto__, constructor, toString)", () => {
  const hostile = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"].map((id, i) =>
    change(id, "arbor-hills", new Date(now - i * 60000).toISOString()))
  const first = M.alertStep(null, [], "all", [], now)
  const step = M.alertStep(first.seen, hostile, "all", [], now)
  assert.equal(step.each.length + step.more, 5, "every one is announced, none read as seen")
  assert.equal(M.alertStep(step.seen, hostile, "all", [], now).each.length, 0, "and each only once")
  assert.equal(Object.getPrototypeOf(M.seenSet(hostile).ids), null)
})

test("an alert says the day when the change wasn't today", () => {
  const at = (iso) => M.alertText(change("1", "x", iso), now).body.split("\n")[0]
  assert.equal(at("2026-11-14T13:55:00Z"), "Was open · reported 7:55 AM")
  assert.equal(at("2026-11-13T18:55:00Z"), "Was open · reported yesterday 12:55 PM")
  assert.equal(at("2026-11-11T18:55:00Z"), "Was open · reported Nov 11, 12:55 PM")
})

test("what was seen is never cleared by a short, empty or unusable list; past 1000 the oldest go", () => {
  const list = (from, count) => Array.from({ length: count }, (_, i) => change("c" + (from + i), "arbor-hills", new Date(now - (from + i) * 60000).toISOString()))
  const recent = list(0, 200)
  let seen = M.alertStep(null, recent, "all", [], now).seen
  for (const read of [[], recent.slice(0, 1), null]) seen = M.alertStep(seen, read, "all", [], now).seen
  assert.equal(M.alertStep(seen, recent, "all", [], now).each.length, 0, "the full list again announces nothing")
  // A long session: 1200 ids seen, the oldest 200 forgotten, the current list still remembered
  let long = M.alertStep(null, [], "all", [], now).seen
  for (let from = 1000; from >= 0; from -= 200) long = M.mergeSeen(long, list(from, 200))
  assert.equal(Object.keys(long.ids).length, 1000)
  assert.equal(long.ids.c1100, undefined, "the oldest are forgotten")
  assert.equal(M.alertStep(long, recent, "all", [], now).each.length, 0)
  // An unusable first read is no read
  assert.equal(M.alertStep(null, null, "all", [], now).seen, null)
  assert.equal(M.alertsReset(seen, null), seen)
})

test("a change list whose trail entries are all unusable counts as unreadable; skills parks alone are just no changes", () => {
  assert.equal(M.parseChanges('{"statusChanges":[{"type":"trail","id":"x"}]}'), null)
  assert.deepEqual(plain(M.parseChanges('{"statusChanges":[{"type":"skills_park","id":"x","at":"2026-11-14T00:00:00Z","slug":"a","status":"open"}]}')), [])
})

test("an id seen again keeps its first-seen place, so the oldest really are forgotten first", () => {
  const a = change("a", "arbor-hills", "2026-11-14T13:00:00Z")
  const b = change("b", "arbor-hills", "2026-11-14T13:10:00Z")
  const seen = M.mergeSeen(M.seenSet([a]), [b, a])
  assert.deepEqual([seen.ids.a, seen.ids.b, seen.n], [1, 2, 2])
})
